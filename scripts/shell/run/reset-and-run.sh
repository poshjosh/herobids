#!/usr/bin/env bash
# reset-and-run.sh — Tear down all services, rebuild from scratch, and provision the first user.
#
# Steps:
#   0. Stop ngrok tunnel if running (from a prior invocation)
#   1. docker compose down -v --remove-orphans + docker system prune
#   2. scripts/shell/run/build-and-run.sh  (build, lint, agent image, compose up, Ollama warmup, seed admin)
#   3. Start ngrok tunnel + register Telegram webhook (if TELEGRAM_BOT_TOKEN is configured)
#   4. scripts/shell/ops/quick-setup.sh   (API-level user account + credential + connection setup)
#   5. scripts/shell/run/create-agents.sh (create thyper + t1inch trading agents)
#
# Usage:
#   scripts/shell/run/reset-and-run.sh
#   scripts/shell/run/reset-and-run.sh --skip-setup   # skip quick-setup.sh
#
# WARNING: This destroys all local data volumes. Do not run against a live environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKIP_SETUP=0

# Load .env.ops.dev if present (provides TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, etc.)
ENV_FILE="$REPO_ROOT/.env.ops.dev"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

error_exit() {
    log "ERROR: $1"
    exit "${2:-1}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-setup)
      SKIP_SETUP=1
      shift
      ;;
    -h|--help)
      awk '/^[^#]/{exit} /^#/{sub(/^# ?/,""); print}' "$0"
      exit 0
      ;;
    *)
      error_exit "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 0 — Stop ngrok tunnel from a prior invocation (safe no-op if not running)
# ---------------------------------------------------------------------------

NGROK_SETUP_SCRIPT="$REPO_ROOT/scripts/shell/tests/setup-local-telegram-webhook.sh"
if [[ -x "$NGROK_SETUP_SCRIPT" ]]; then
  log "Step 0: Stopping ngrok tunnel (if running)..."
  bash "$NGROK_SETUP_SCRIPT" --stop 2>&1 | sed 's/^/  /' || true
fi

# ---------------------------------------------------------------------------
# Step 1 — Tear down
# ---------------------------------------------------------------------------

log "Step 1: Tearing down services and pruning Docker..."
# EXTRA_COMPOSE_FILES (optional): additional `-f <file>` overlays so the down
# matches the bring-up file set (e.g. docker/xstack.override.yml from the
# cross-stack runner). Empty by default → standalone reset unchanged.
# shellcheck disable=SC2086
docker compose -f "$REPO_ROOT/docker-compose.yaml" -f "$REPO_ROOT/docker-compose.dev.yaml" ${EXTRA_COMPOSE_FILES:-} \
  down -v --remove-orphans || error_exit "docker compose down failed"
docker system prune -f || error_exit "docker system prune failed"

# ---------------------------------------------------------------------------
# Step 2 — Build and run
# ---------------------------------------------------------------------------

log "Step 2: Running build-and-run.sh..."
bash "$SCRIPT_DIR/build-and-run.sh" || error_exit "build-and-run.sh failed"

# ---------------------------------------------------------------------------
# Step 3 — Start ngrok tunnel + register Telegram webhook
# ---------------------------------------------------------------------------

if [[ -x "$NGROK_SETUP_SCRIPT" ]] && [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_WEBHOOK_SECRET:-}" ]]; then
  log "Step 3: Starting ngrok tunnel and registering Telegram webhook..."
  bash "$NGROK_SETUP_SCRIPT" || log "WARNING: ngrok setup failed (stack is still usable without Telegram webhook)"
else
  log "Step 3: Skipping ngrok tunnel (TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET not set, or setup script not found)"
fi

# ---------------------------------------------------------------------------
# Step 4 — User account setup
# ---------------------------------------------------------------------------

if [[ "$SKIP_SETUP" -eq 1 ]]; then
  log "Step 4: Skipping quick-setup.sh (--skip-setup)"
else
  # Wait for the API to become healthy before hitting endpoints.
  # docker compose up -d returns immediately; the API needs time to boot.
  API_URL="${API_BASE_URL:-http://localhost:3000}"
  log "Step 4a: Waiting for API to be ready at $API_URL/health..."
  MAX_WAIT=60
  ELAPSED=0
  until curl -sf "$API_URL/health" > /dev/null 2>&1; do
    if [[ $ELAPSED -ge $MAX_WAIT ]]; then
      error_exit "API did not become healthy within ${MAX_WAIT}s"
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
  done
  log "API healthy after ~${ELAPSED}s."

  log "Step 4b: Running quick-setup.sh..."
  bash "$SCRIPT_DIR/../ops/quick-setup.sh" || error_exit "quick-setup.sh failed"

  log "Step 4c: Running create-agents.sh..."
  bash "$SCRIPT_DIR/create-agents.sh" || error_exit "create-agents.sh failed"
fi

log "Reset and run complete. Stack services are ready; Ollama warmup may still be running in background when enabled."
