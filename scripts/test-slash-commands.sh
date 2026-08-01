#!/usr/bin/env bash
# test-slash-commands.sh — Local mock Telegram webhook helper
#
# Two modes:
#   A. Single-message mode (--message-text TEXT)
#      Posts one sample Telegram update to the local webhook endpoint and
#      reports the HTTP response. Use this for fast ingress-path iteration.
#
#   B. Batch test suite (default, no --message-text)
#      Runs multiple slash commands in sequence against the local endpoint.
#      Useful for smoke-testing command parsing and routing.
#
# Prerequisites:
#   - docker compose up -d (api + worker must be running)
#   - TELEGRAM_WEBHOOK_SECRET configured in app
#   - A user linked to the target chat_id in DB (for routable commands)
#
# Usage:
#   # Batch suite (backward compatible)
#   ./scripts/test-slash-commands.sh
#   ./scripts/test-slash-commands.sh 123456789          # custom chat_id
#
#   # Single message (fast ingress test)
#   ./scripts/test-slash-commands.sh --message-text "Hello from mock"
#   ./scripts/test-slash-commands.sh --message-text "/to MyAgent check BTC" --chat-id 123456789
#
#   # Negative-path: wrong secret
#   ./scripts/test-slash-commands.sh --message-text "test" --wrong-secret
#
#   # Override env / config
#   ./scripts/test-slash-commands.sh --env-file .env.ops.dev --message-text "Hello"
#   ./scripts/test-slash-commands.sh --webhook-secret my-secret --chat-id 123 --message-text "hi"
#   ./scripts/test-slash-commands.sh --api-base https://staging.example.com --message-text "ping"
#
# Flags:
#   --env-file FILE        Load env vars from FILE (set -a; source; set +a)
#   --webhook-secret SECRET  Override WEBHOOK_SECRET
#   --chat-id ID           Override CHAT_ID
#   --message-text TEXT    Single-message mode: POST one update and exit
#   --wrong-secret         Use a deliberately wrong secret (expect 401)
#   --api-base URL         Override API_BASE (default: http://localhost:3000)
#   --help                 Show this help and exit
#
# Responses are sent asynchronously to the real Telegram chat via the Bot API.
# Check your Telegram app for responses.

set -euo pipefail

## ─── Color helpers ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[→]${NC} $*"; }

## ─── Set defaults ──────────────────────────────────────────────────────────

API_BASE="${API_BASE:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-secret-123}"
CHAT_ID=""
MESSAGE_TEXT=""
WRONG_SECRET=false
ENV_FILE=""
POSITIONAL_CHAT_ID=""

## ─── Load env file early (before CLI flags, so flags can override env) ─────

_preview_arg=""
for _arg in "$@"; do
  if [[ "$_preview_arg" == "--env-file" ]]; then
    ENV_FILE="$_arg"
    break
  fi
  _preview_arg="$_arg"
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: env file not found: $ENV_FILE" >&2
    exit 2
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

## ─── Argument parsing ────────────────────────────────────────────────────────

## Capture first positional arg before flag parsing (backward compat)
if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
  POSITIONAL_CHAT_ID="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ -z "${2:-}" ]] && { echo "Error: --env-file requires a path argument" >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --webhook-secret)
      [[ -z "${2:-}" ]] && { echo "Error: --webhook-secret requires a value" >&2; exit 2; }
      WEBHOOK_SECRET="$2"
      shift 2
      ;;
    --chat-id)
      [[ -z "${2:-}" ]] && { echo "Error: --chat-id requires a value" >&2; exit 2; }
      CHAT_ID="$2"
      shift 2
      ;;
    --message-text)
      [[ -z "${2:-}" ]] && { echo "Error: --message-text requires a value" >&2; exit 2; }
      MESSAGE_TEXT="$2"
      shift 2
      ;;
    --wrong-secret)
      WRONG_SECRET=true
      shift
      ;;
    --api-base)
      [[ -z "${2:-}" ]] && { echo "Error: --api-base requires a URL" >&2; exit 2; }
      API_BASE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '/^#/{/^#!/d;/^#$/d;s/^# \{0,1\}//p;}' "$0"
      exit 0
      ;;
    *)
      echo "Error: unknown flag: $1" >&2
      echo "Run with --help for usage." >&2
      exit 2
      ;;
  esac
done

## ─── Resolve CHAT_ID ─────────────────────────────────────────────────────────

## --chat-id flag takes precedence, then positional arg, then env, then default
if [[ -z "$CHAT_ID" ]]; then
  if [[ -n "$POSITIONAL_CHAT_ID" ]]; then
    CHAT_ID="$POSITIONAL_CHAT_ID"
  elif [[ -n "${CHAT_ID_ENV:-}" ]]; then
    CHAT_ID="$CHAT_ID_ENV"
  else
    CHAT_ID="8681143261"
  fi
fi

## Allow env var overrides after arg parsing (consistent with reference script)
API_BASE="${API_BASE:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-secret-123}"

## ─── Validate --wrong-secret usage ───────────────────────────────────────────

if [[ "$WRONG_SECRET" == true && -z "$MESSAGE_TEXT" ]]; then
  warn "--wrong-secret has no effect without --message-text; ignoring"
  WRONG_SECRET=false
fi

## ═══════════════════════════════════════════════════════════════════════════════
## Single-message mode
## ═══════════════════════════════════════════════════════════════════════════════

send_single_message() {
  local text="$1"
  local secret_to_use="$WEBHOOK_SECRET"
  local expect_401=false

  if [[ "$WRONG_SECRET" == true ]]; then
    secret_to_use="wrong-secret"
    expect_401=true
  fi

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║     Telegram Mock Webhook — Single Message                 ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║ API:      ${API_BASE}"
  echo "║ Secret:   ${secret_to_use}"
  echo "║ Chat ID:  ${CHAT_ID}"
  echo "║ Message:  ${text}"
  if [[ "$expect_401" == true ]]; then
    echo "║ Mode:     negative-path (expecting 401)"
  fi
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  # Check jq dependency
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed" >&2
    exit 2
  fi

  # Use jq to construct safe JSON payload (prevents injection via --message-text)
  local payload
  payload=$(jq -n \
    --arg text "$text" \
    --arg chat_id "$CHAT_ID" \
    --argjson now "$(date +%s)" \
    '{
      update_id: 999999,
      message: {
        message_id: 1,
        from: { id: ($chat_id | tonumber), is_bot: false, first_name: "TestUser", username: "testuser", type: "private" },
        chat: { id: ($chat_id | tonumber), first_name: "TestUser", username: "testuser", type: "private" },
        date: $now,
        text: $text
      }
    }')

  # Use curl -w pattern to capture both body and status code
  local response
  response=$(echo "$payload" | curl -s -w "\n%{http_code}" \
    -X POST "${API_BASE}/telegram/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: ${secret_to_use}" \
    -d @-)

  local http_code
  http_code=$(echo "$response" | tail -n1)
  local body
  body=$(echo "$response" | sed '$d')

  echo "── Response ──"
  echo "  HTTP status: ${http_code}"
  echo "  Body:        ${body}"

  echo ""
  echo "── Interpretation ──"

  if [[ "$http_code" == "200" ]]; then
    if [[ "$expect_401" == true ]]; then
      fail "Expected 401 (wrong secret), got 200 — secret validation may be broken"
      return 1
    fi
    log "webhook accepted; async routing may still fail — check Telegram for response"
    echo ""
    info "Next: check these for async routing success:"
    info "  1. Telegram app — the bot should reply if the message routed successfully"
    info "  2. API logs — look for 'processWebhookUpdate' warnings or errors"
    info "  3. Downstream state — check if the command produced expected side effects"
  elif [[ "$http_code" == "401" ]]; then
    if [[ "$expect_401" == true ]]; then
      log "webhook secret mismatch (correctly rejected)"
    else
      fail "webhook secret mismatch — check WEBHOOK_SECRET"
    fi
  elif [[ "$http_code" == "501" ]]; then
    fail "bot token or webhook secret not configured in app"
  else
    warn "unexpected HTTP ${http_code} — see body above"
  fi
}

## ═══════════════════════════════════════════════════════════════════════════════
## Batch test suite (existing functionality)
## ═══════════════════════════════════════════════════════════════════════════════

UPDATE_ID=0

webhook() {
  local text="$1"
  UPDATE_ID=$((UPDATE_ID + 1))
  local msg_id=$UPDATE_ID

  echo ""
  echo "══════════════════════════════════════════"
  echo "▶  /$text"
  echo "══════════════════════════════════════════"

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_BASE}/telegram/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: ${WEBHOOK_SECRET}" \
    -d "{
      \"update_id\": ${UPDATE_ID},
      \"message\": {
        \"message_id\": ${msg_id},
        \"chat\": { \"id\": ${CHAT_ID}, \"type\": \"private\" },
        \"date\": $(date +%s),
        \"text\": \"/${text}\"
      }
    }")

  if [ "$http_code" = "200" ]; then
    log "HTTP ${http_code} — check Telegram for response"
  else
    fail "HTTP ${http_code}"
    # Show error body for non-200
    curl -s -X POST "${API_BASE}/telegram/webhook" \
      -H "Content-Type: application/json" \
      -H "X-Telegram-Bot-Api-Secret-Token: ${WEBHOOK_SECRET}" \
      -d "{\"update_id\":${UPDATE_ID},\"message\":{\"message_id\":${msg_id},\"chat\":{\"id\":${CHAT_ID},\"type\":\"private\"},\"date\":$(date +%s),\"text\":\"/${text}\"}}" 2>&1
  fi

  # Brief pause so Telegram rate limits aren't hit
  sleep 0.3
}

run_batch_suite() {
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║     Telegram Slash Command Test Suite                      ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║ API:      ${API_BASE}"
  echo "║ Secret:   ${WEBHOOK_SECRET}"
  echo "║ Chat ID:  ${CHAT_ID}"
  echo "║                                                              ║"
  echo "║ Responses arrive in your Telegram app (async).              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"

  ## ── Help (no user binding required) ──────────────────────────────────────

  echo ""
  echo "── Help ──"
  webhook "help"
  webhook "help start"
  webhook "help status"

  ## ── Discovery & Read-Only ────────────────────────────────────────────────

  echo ""
  echo "── Discovery ──"
  webhook "agents"
  webhook "status"
  webhook "info thyper"
  webhook "skills"
  webhook "skills thyper"
  webhook "log thyper"
  webhook "connections"
  webhook "connections thyper"

  ## ── Configuration ─────────────────────────────────────────────────────────

  echo ""
  echo "── Configuration ──"
  webhook "mode thyper"

  ## ── Messaging ─────────────────────────────────────────────────────────────

  echo ""
  echo "── Messaging ──"
  webhook "to thyper Hello from the test script! What markets are you watching?"

  ## ── Auth edge cases ──────────────────────────────────────────────────────

  echo ""
  echo "── Edge Cases ──"
  ## Test with wrong secret
  echo ""
  echo "▶  Wrong webhook secret"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_BASE}/telegram/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: wrong-secret" \
    -d '{"update_id":999,"message":{"message_id":999,"chat":{"id":'"${CHAT_ID}"',"type":"private"},"date":1700000000,"text":"/help"}}')
  if [ "$http_code" = "401" ]; then
    log "HTTP 401 (correctly rejected)"
  else
    fail "Expected 401, got ${http_code}"
  fi

  # Test with unbound chat (no DB user)
  echo ""
  echo "▶  Unbound chat /agents"
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_BASE}/telegram/webhook" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: ${WEBHOOK_SECRET}" \
    -d '{"update_id":998,"message":{"message_id":998,"chat":{"id":99999,"type":"private"},"date":1700000000,"text":"/agents"}}')
  echo "  HTTP ${http_code} — should get 'bind your Telegram account' in Telegram (chat 99999 won't receive, but check API logs)"

  echo ""
  echo "══════════════════════════════════════════"
  echo "  Done. Check your Telegram app!"
  echo "══════════════════════════════════════════"
}

## ═══════════════════════════════════════════════════════════════════════════════
## Main dispatch
## ═══════════════════════════════════════════════════════════════════════════════

if [[ -n "$MESSAGE_TEXT" ]]; then
  send_single_message "$MESSAGE_TEXT"
else
  run_batch_suite
fi
