#!/usr/bin/env bash
# test-slash-commands.sh — Test Telegram slash commands via local webhook endpoint
#
# Prerequisites:
#   - docker compose up -d (api + worker must be running)
#   - TELEGRAM_WEBHOOK_SECRET=dev-secret-123 in .env
#   - A user linked to telegram_chat_id 8681143261 in DB
#
# Usage: ./scripts/test-slash-commands.sh [chat_id]
#
# Responses are sent asynchronously to the real Telegram chat via the Bot API.
# Check your Telegram app for responses.

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-secret-123}"
CHAT_ID="${1:-8681143261}"
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
    echo "  ✓ HTTP ${http_code} — check Telegram for response"
  else
    echo "  ✗ HTTP ${http_code}"
    # Show error body for non-200
    curl -s -X POST "${API_BASE}/telegram/webhook" \
      -H "Content-Type: application/json" \
      -H "X-Telegram-Bot-Api-Secret-Token: ${WEBHOOK_SECRET}" \
      -d "{\"update_id\":${UPDATE_ID},\"message\":{\"message_id\":${msg_id},\"chat\":{\"id\":${CHAT_ID},\"type\":\"private\"},\"date\":$(date +%s),\"text\":\"/${text}\"}}" 2>&1
  fi

  # Brief pause so Telegram rate limits aren't hit
  sleep 0.3
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     Telegram Slash Command Test Suite                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║ API:      ${API_BASE}"
echo "║ Secret:   ${WEBHOOK_SECRET}"
echo "║ Chat ID:  ${CHAT_ID}"
echo "║                                                              ║"
echo "║ Responses arrive in your Telegram app (async).              ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── Help (no user binding required) ──────────────────────────────────────

echo ""
echo "── Help ──"
webhook "help"
webhook "help start"
webhook "help status"

# ── Discovery & Read-Only ────────────────────────────────────────────────

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

# ── Configuration ─────────────────────────────────────────────────────────

echo ""
echo "── Configuration ──"
webhook "mode thyper"

# ── Messaging ─────────────────────────────────────────────────────────────

echo ""
echo "── Messaging ──"
webhook "to thyper Hello from the test script! What markets are you watching?"

# ── Auth edge cases ──────────────────────────────────────────────────────

echo ""
echo "── Edge Cases ──"
# Test with wrong secret
echo ""
echo "▶  Wrong webhook secret"
http_code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${API_BASE}/telegram/webhook" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: wrong-secret" \
  -d '{"update_id":999,"message":{"message_id":999,"chat":{"id":'"${CHAT_ID}"',"type":"private"},"date":1700000000,"text":"/help"}}')
if [ "$http_code" = "401" ]; then
  echo "  ✓ HTTP 401 (correctly rejected)"
else
  echo "  ✗ Expected 401, got ${http_code}"
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
