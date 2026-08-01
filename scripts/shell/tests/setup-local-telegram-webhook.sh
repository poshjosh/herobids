#!/usr/bin/env bash
# setup-local-telegram-webhook.sh — One-shot local Telegram webhook tunnel setup.
# Starts/reuses an ngrok tunnel to localhost:3000, registers it as the Telegram
# bot webhook, and verifies the registration.
#
# Usage:
#   scripts/shell/tests/setup-local-telegram-webhook.sh --env-file .env.ops.dev
#   scripts/shell/tests/setup-local-telegram-webhook.sh --stop
#
# Required env vars (in env file or environment):
#   TELEGRAM_BOT_TOKEN       — the bot token
#   TELEGRAM_WEBHOOK_SECRET  — webhook secret token
#
# Optional:
#   TELEGRAM_WEBHOOK_URL     — if set, warns when it doesn't match the tunnel URL
#
# Exit codes:
#   0 = webhook registered successfully
#   1 = one or more steps failed
#   2 = missing prerequisites (env vars, tools)

set -euo pipefail

# ─── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()         { echo -e "${GREEN}[✓]${NC} $*"; }
warn()        { echo -e "${YELLOW}[!]${NC} $*"; }
fail()        { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
info()        { echo -e "${BLUE}[→]${NC} $*"; }
prereq_fail() { echo -e "${RED}[✗]${NC} $*"; exit 2; }

run_curl_into() {
  local target_var="$1"
  local label="$2"
  shift 2

  local output
  if ! output=$(curl "$@" 2>&1); then
    fail "${label} transport error: ${output}"
  fi

  printf -v "$target_var" '%s' "$output"
}

# ─── PID file for ngrok child process tracking ───────────────────────────────

NGROK_PID_FILE="/tmp/setup-local-telegram-webhook-ngrok.pid"

# ─── Argument parsing ────────────────────────────────────────────────────────

ENV_FILE=""
DO_STOP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && prereq_fail "--env-file requires a path argument"
      ENV_FILE="$2"
      shift 2
      ;;
    --stop)
      DO_STOP=true
      shift
      ;;
    -h|--help)
      sed -n '/^#/{/^#!/d;/^#$/d;s/^# \{0,1\}//p;}' "$0"
      exit 0
      ;;
    *)
      prereq_fail "Unknown option: $1  (use --help for usage)"
      ;;
  esac
done

# ─── Stop mode ───────────────────────────────────────────────────────────────

if [[ "$DO_STOP" == "true" ]]; then
  if [[ -f "$NGROK_PID_FILE" ]]; then
    NGROK_PID=$(cat "$NGROK_PID_FILE")
    if kill -0 "$NGROK_PID" 2>/dev/null; then
      info "Stopping ngrok (PID ${NGROK_PID})..."
      kill "$NGROK_PID" 2>/dev/null || true
      sleep 1
      # Force kill if still alive
      if kill -0 "$NGROK_PID" 2>/dev/null; then
        kill -9 "$NGROK_PID" 2>/dev/null || true
      fi
      log "ngrok stopped."
    else
      warn "ngrok PID ${NGROK_PID} from pid file is not running."
    fi
    rm -f "$NGROK_PID_FILE"
  else
    warn "No ngrok PID file found (${NGROK_PID_FILE}). Nothing to stop."
  fi
  exit 0
fi

# ─── Load env file ───────────────────────────────────────────────────────────

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || prereq_fail "Environment file not found: ${ENV_FILE}"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  log "Loaded env file: ${ENV_FILE}"
fi

# ─── Prerequisites ───────────────────────────────────────────────────────────

for cmd in curl jq ngrok; do
  command -v "$cmd" >/dev/null 2>&1 || prereq_fail "'$cmd' is required but not installed."
done

[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]      || prereq_fail "TELEGRAM_BOT_TOKEN is not set"
[[ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]] || prereq_fail "TELEGRAM_WEBHOOK_SECRET is not set"

MASKED_TOKEN="$(echo "${TELEGRAM_BOT_TOKEN}" | sed 's/\(.\{8\}\).*/\1****/')"
log "TELEGRAM_BOT_TOKEN=${MASKED_TOKEN}"
log "TELEGRAM_WEBHOOK_SECRET=(set, masked)"

TG_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# ─── Cleanup trap for ngrok started by this script ────────────────────────

cleanup_ngrok() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 && "$NGROK_STARTED_BY_US" == "true" && -f "$NGROK_PID_FILE" ]]; then
    local pid
    pid=$(cat "$NGROK_PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$NGROK_PID_FILE"
  fi
}
trap cleanup_ngrok EXIT

# ─── Step 1 — ngrok tunnel ───────────────────────────────────────────────────

echo ""
info "Step 1/5: ngrok tunnel to localhost:3000"

NGROK_API="http://localhost:4040/api/tunnels"
TUNNEL_URL=""
NGROK_STARTED_BY_US=false

# Check if ngrok is already running with a tunnel on port 3000
NGROK_RESPONSE=$(curl -sS --max-time 5 "${NGROK_API}" 2>/dev/null || true)
if [[ -n "$NGROK_RESPONSE" ]]; then
  TUNNEL_URL=$(echo "$NGROK_RESPONSE" | jq -r '.tunnels[] | select(.config.addr | test("localhost:3000$")) | .public_url' 2>/dev/null || echo "")
  if [[ -n "$TUNNEL_URL" ]]; then
    log "Reusing existing ngrok tunnel: ${TUNNEL_URL}"
  fi
fi

# Start ngrok if no existing tunnel found
if [[ -z "$TUNNEL_URL" ]]; then
  info "Starting ngrok http 3000..."
  ngrok http 3000 --log=stdout > /dev/null &
  NGROK_PID=$!
  echo "$NGROK_PID" > "$NGROK_PID_FILE"
  NGROK_STARTED_BY_US=true
  log "ngrok started (PID ${NGROK_PID})"

  # Wait for ngrok API to become available
  info "Waiting for ngrok tunnel to be ready..."
  for i in $(seq 1 15); do
    sleep 1
    if curl -sS --max-time 3 "${NGROK_API}" > /dev/null 2>&1; then
      break
    fi
    if [[ $i -eq 15 ]]; then
      fail "ngrok did not become ready within 15 seconds"
    fi
  done

  # Read the tunnel URL from the API
  run_curl_into NGROK_RESPONSE "ngrok tunnel discovery" -sS --max-time 5 "${NGROK_API}"
  TUNNEL_URL=$(echo "$NGROK_RESPONSE" | jq -r '.tunnels[] | select(.config.addr | test("localhost:3000$")) | .public_url')
  if [[ -z "$TUNNEL_URL" ]]; then
    fail "Could not discover ngrok tunnel URL for localhost:3000"
  fi
  log "Tunnel established: ${TUNNEL_URL}"
fi

WEBHOOK_URL="${TUNNEL_URL}/telegram/webhook"

# ─── Step 2 — Delete existing webhook ────────────────────────────────────────

echo ""
info "Step 2/5: Delete existing Telegram webhook"

run_curl_into DEL_RESPONSE "Telegram deleteWebhook" -sS --max-time 10 "${TG_API}/deleteWebhook"
DEL_OK=$(echo "$DEL_RESPONSE" | jq -r '.ok // false')

if [[ "$DEL_OK" != "true" ]]; then
  DEL_DESC=$(echo "$DEL_RESPONSE" | jq -r '.description // "unknown error"')
  fail "Failed to delete webhook: ${DEL_DESC}"
fi
log "Existing webhook deleted"

# ─── Step 3 — Register webhook ───────────────────────────────────────────────

echo ""
info "Step 3/5: Register webhook with Telegram"

run_curl_into SET_RESPONSE "Telegram setWebhook" -sS --max-time 10 -X POST "${TG_API}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${WEBHOOK_URL}\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\"}"

SET_OK=$(echo "$SET_RESPONSE" | jq -r '.ok // false')

if [[ "$SET_OK" != "true" ]]; then
  SET_DESC=$(echo "$SET_RESPONSE" | jq -r '.description // "unknown error"') || true
  fail "Failed to set webhook: ${SET_DESC:-unknown error}"
fi
log "Webhook registered: ${WEBHOOK_URL}"

# ─── Step 4 — Verify registration ────────────────────────────────────────────

echo ""
info "Step 4/5: Verify webhook registration"

run_curl_into WH_RESPONSE "Telegram getWebhookInfo" -sS --max-time 10 "${TG_API}/getWebhookInfo"
WH_OK=$(echo "$WH_RESPONSE" | jq -r '.ok // false')

if [[ "$WH_OK" != "true" ]]; then
  WH_DESC=$(echo "$WH_RESPONSE" | jq -r '.description // "unknown error"') || true
  fail "Could not verify webhook: ${WH_DESC:-unknown error}"
fi

REGISTERED_URL=$(echo "$WH_RESPONSE" | jq -r '.result.url // ""')
PENDING=$(echo "$WH_RESPONSE" | jq -r '.result.pending_update_count // 0')
HAS_CUSTOM_CERT=$(echo "$WH_RESPONSE" | jq -r '.result.has_custom_certificate // false')
LAST_ERROR=$(echo "$WH_RESPONSE" | jq -r '.result.last_error_message // ""')

if [[ "$REGISTERED_URL" != "$WEBHOOK_URL" ]]; then
  echo -e "  Expected URL   → ${GREEN}${WEBHOOK_URL}${NC}"
  echo -e "  Registered URL → ${RED}${REGISTERED_URL}${NC}"
  fail "Webhook URL mismatch — registration may not have taken effect"
fi

log "Webhook URL verified: ${REGISTERED_URL}"

if [[ "$HAS_CUSTOM_CERT" == "true" ]]; then
  warn "Custom certificate is set — verify this is intentional (ngrok provides its own TLS)"
fi

if [[ -n "$LAST_ERROR" ]]; then
  LAST_ERROR_DATE=$(echo "$WH_RESPONSE" | jq -r '.result.last_error_date // 0')
  warn "Telegram reported a previous webhook delivery error: ${LAST_ERROR} (at unix ${LAST_ERROR_DATE})"
fi

if [[ "$PENDING" -gt 0 ]]; then
  warn "${PENDING} pending update(s) queued in Telegram — they will be delivered to the new webhook"
fi

# ─── Step 5 — Config consistency warning ─────────────────────────────────────

echo ""
info "Step 5/5: Config consistency check"

if [[ -n "${TELEGRAM_WEBHOOK_URL:-}" ]]; then
  if [[ "${TELEGRAM_WEBHOOK_URL}" != "${WEBHOOK_URL}" ]]; then
    warn "TELEGRAM_WEBHOOK_URL (${TELEGRAM_WEBHOOK_URL}) differs from tunnel URL."
    warn "  The next worker restart WILL overwrite this registration with ${TELEGRAM_WEBHOOK_URL}."
    warn "  → Either update TELEGRAM_WEBHOOK_URL to ${WEBHOOK_URL} or unset it."
  else
    log "TELEGRAM_WEBHOOK_URL matches the registered tunnel URL"
  fi
else
  info "TELEGRAM_WEBHOOK_URL is not set in config."
  info "  The worker will skip webhook registration on restart — this tunnel registration will persist."
  info "  → Set TELEGRAM_WEBHOOK_URL=${WEBHOOK_URL} in your env file to make the registration explicit."
fi

# ─── Next steps ──────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────────────────"
echo -e " ${GREEN}Webhook is live!${NC}"
echo ""
echo -e " Send a Telegram message to your bot to test inbound delivery."
echo -e " Check worker logs for webhook processing:"
echo -e "   ${BLUE}docker compose logs -f worker${NC}"
echo ""
echo -e " To stop the ngrok tunnel when done:"
echo -e "   ${BLUE}$0 --stop${NC}"
echo "──────────────────────────────────────────────────"

# ─── Summary ─────────────────────────────────────────────────────────────────

# Clean up PID file if we reused a pre-existing ngrok (not ours to stop)
if [[ "$NGROK_STARTED_BY_US" == "false" ]]; then
  rm -f "$NGROK_PID_FILE"
fi

echo ""
echo "================================================"
echo -e " ${GREEN}Webhook registered successfully${NC}"
echo -e " URL: ${WEBHOOK_URL}"
echo "================================================"
exit 0
