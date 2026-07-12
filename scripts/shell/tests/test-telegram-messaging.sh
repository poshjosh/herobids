#!/usr/bin/env bash
# test-telegram-messaging.sh — End-to-end Telegram messaging diagnostic.
# Calls Telegram's API directly — no HeroBids auth token required.
# Fails fast at each step.
#
# What this script validates:
#   1. HeroBids API is healthy
#   2. Bot token is valid (Telegram getMe)
#   3. Webhook is registered and matches EXPECTED_WEBHOOK_URL
#   4. Pending updates check — warns if messages are stuck in the queue
#   5. Each chat ID is reachable (Telegram sendMessage)
#
# Usage:
#   scripts/shell/tests/test-telegram-messaging.sh --env-file .env.ops.dev
#
#   # Override individual vars:
#   TEST_CHAT_IDS=6846862012 ./test-telegram-messaging.sh --env-file .env.ops.dev
#
# Required env vars (in env file or environment):
#   API_BASE_URL           — e.g. https://openaidom.com or http://localhost:3000
#   TELEGRAM_BOT_TOKEN     — the bot token
#   TEST_CHAT_IDS          — comma-separated chat IDs to verify
#
# Optional:
#   EXPECTED_WEBHOOK_URL   — assert this URL is registered; skip check if blank
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed
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
fail()        { echo -e "${RED}[✗]${NC} $*"; exit 1; }
info()        { echo -e "${BLUE}[→]${NC} $*"; }
prereq_fail() { echo -e "${RED}[✗]${NC} $*"; exit 2; }

# ─── Argument parsing ────────────────────────────────────────────────────────

ENV_FILE=""
FAILURES=0
CHAT_IDS=()
FAILED_CHATS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && prereq_fail "--env-file requires a path argument"
      ENV_FILE="$2"
      shift 2
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

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || prereq_fail "'$cmd' is required but not installed."
done

[[ -n "${API_BASE_URL:-}" ]]    || prereq_fail "API_BASE_URL is not set"
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]  || prereq_fail "TELEGRAM_BOT_TOKEN is not set"
[[ -n "${TEST_CHAT_IDS:-}" ]]       || prereq_fail "TEST_CHAT_IDS is not set"

IFS=',' read -ra CHAT_IDS <<< "${TEST_CHAT_IDS}"

MASKED_TOKEN="$(echo "${TELEGRAM_BOT_TOKEN}" | sed 's/\(.\{8\}\).*/\1****/')"
log "API_BASE_URL=${API_BASE_URL}"
log "TELEGRAM_BOT_TOKEN=${MASKED_TOKEN}"
log "Chat IDs to verify: ${#CHAT_IDS[@]} (${TEST_CHAT_IDS})"
[[ -n "${EXPECTED_WEBHOOK_URL:-}" ]] && log "Expected webhook URL: ${EXPECTED_WEBHOOK_URL}"

TG_API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# ─── Step 1 — API health check ───────────────────────────────────────────────

echo ""
info "Step 1/5: HeroBids API health check"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${API_BASE_URL}/health")
[[ "$HTTP" == "200" ]] || fail "API health check failed (HTTP ${HTTP} at ${API_BASE_URL}/health)"
log "API healthy (${API_BASE_URL}/health)"

# ─── Step 2 — Bot token validity ─────────────────────────────────────────────

echo ""
info "Step 2/5: Bot token validity (Telegram getMe)"

ME_RESPONSE=$(curl -s --max-time 10 "${TG_API}/getMe")
ME_OK=$(echo "$ME_RESPONSE" | jq -r '.ok // false')

if [[ "$ME_OK" != "true" ]]; then
  ME_DESC=$(echo "$ME_RESPONSE" | jq -r '.description // "unknown error"')
  fail "Bot token is invalid or unreachable: ${ME_DESC}"
fi

BOT_USERNAME=$(echo "$ME_RESPONSE" | jq -r '.result.username // empty')
log "Bot is alive: @${BOT_USERNAME}"

# ─── Step 3 — Webhook registration check ─────────────────────────────────────

echo ""
info "Step 3/5: Webhook registration (Telegram getWebhookInfo)"

WH_RESPONSE=$(curl -s --max-time 10 "${TG_API}/getWebhookInfo")
WH_OK=$(echo "$WH_RESPONSE" | jq -r '.ok // false')

if [[ "$WH_OK" != "true" ]]; then
  warn "Could not check webhook info: $(echo "$WH_RESPONSE" | jq -r '.description // "unknown"')"
  FAILURES=$((FAILURES + 1))
else
  REGISTERED_URL=$(echo "$WH_RESPONSE" | jq -r '.result.url // ""')
  PENDING=$(echo "$WH_RESPONSE" | jq -r '.result.pending_update_count // 0')
  LAST_ERROR=$(echo "$WH_RESPONSE" | jq -r '.result.last_error_message // ""')

  if [[ -z "$REGISTERED_URL" ]]; then
    echo -e "  Registered URL   → ${RED}none${NC}"
    warn "No webhook URL is registered — inbound Telegram messages will NOT reach the app."
    warn "Set TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET, then restart the worker."
    FAILURES=$((FAILURES + 1))
  else
    echo -e "  Registered URL   → ${GREEN}${REGISTERED_URL}${NC}"
    # Assert expected URL matches if provided
    if [[ -n "${EXPECTED_WEBHOOK_URL:-}" && "$REGISTERED_URL" != "$EXPECTED_WEBHOOK_URL" ]]; then
      warn "Registered URL does not match EXPECTED_WEBHOOK_URL"
      warn "  Expected: ${EXPECTED_WEBHOOK_URL}"
      warn "  Got:      ${REGISTERED_URL}"
      FAILURES=$((FAILURES + 1))
    else
      log "Webhook URL is correctly registered"
    fi
  fi

  # Pending updates warning
  if [[ "$PENDING" -gt 0 ]]; then
    warn "${PENDING} pending update(s) queued in Telegram — messages not yet delivered to the app"
    if [[ -z "$REGISTERED_URL" ]]; then
      warn "This is expected when no webhook is registered. Register the webhook to consume them."
    fi
  else
    log "No pending updates"
  fi

  # Last error from Telegram
  if [[ -n "$LAST_ERROR" ]]; then
    LAST_ERROR_DATE=$(echo "$WH_RESPONSE" | jq -r '.result.last_error_date // 0')
    warn "Telegram reported a webhook delivery error: ${LAST_ERROR} (at unix ${LAST_ERROR_DATE})"
    FAILURES=$((FAILURES + 1))
  fi
fi

# ─── Step 4 — Pending updates detail ─────────────────────────────────────────

echo ""
info "Step 4/5: Pending updates content"

UPDATES_RESPONSE=$(curl -s --max-time 10 "${TG_API}/getUpdates")
UPDATES_OK=$(echo "$UPDATES_RESPONSE" | jq -r '.ok // false')

if [[ "$UPDATES_OK" == "true" ]]; then
  UPDATE_COUNT=$(echo "$UPDATES_RESPONSE" | jq '.result | length')
  if [[ "$UPDATE_COUNT" -gt 0 ]]; then
    warn "${UPDATE_COUNT} update(s) stuck in queue (user messages not received by the app):"
    echo "$UPDATES_RESPONSE" | jq -r '.result[] | "  update_id=\(.update_id) from=\(.message.from.username // .message.from.id // "unknown") text=\(.message.text // "(no text)")"'
    FAILURES=$((FAILURES + 1))
  else
    log "No pending updates in queue"
  fi
else
  warn "Could not fetch updates (this is expected when a webhook is active)"
fi

# ─── Step 5 — Chat ID reachability ───────────────────────────────────────────

echo ""
info "Step 5/5: Chat ID reachability (Telegram sendMessage)"

for chatId in "${CHAT_IDS[@]}"; do
  chatId=$(echo "$chatId" | xargs)
  [[ -z "$chatId" ]] && continue

  printf "  %-20s → " "$chatId"

  TG_RESPONSE=$(curl -s --max-time 15 -X POST "${TG_API}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${chatId}\",\"text\":\"HeroBids diagnostic ping ✅\"}")

  TG_OK=$(echo "$TG_RESPONSE" | jq -r '.ok // false')
  TG_DESC=$(echo "$TG_RESPONSE" | jq -r '.description // "unknown error"')

  if [[ "$TG_OK" == "true" ]]; then
    echo -e "${GREEN}reachable${NC}"
  else
    echo -e "${RED}unreachable${NC} — ${TG_DESC}"
    if echo "$TG_DESC" | grep -qi "chat not found\|bot can.*initiate\|blocked\|kicked"; then
      warn "  ↑ User has NOT started the bot or has blocked it."
      warn "    They must open Telegram, find @${BOT_USERNAME}, and send /start"
    fi
    FAILURES=$((FAILURES + 1))
    FAILED_CHATS+=("$chatId")
  fi
done

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "================================================"
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e " ${GREEN}All checks passed${NC} — Telegram messaging is healthy."
  echo "================================================"
  exit 0
else
  echo -e " ${RED}${FAILURES} check(s) failed${NC} — review output above."
  echo "================================================"
  exit 1
fi
