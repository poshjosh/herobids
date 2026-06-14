#!/usr/bin/env bash
# reset-and-run.sh — Tear down all services, rebuild from scratch, and provision the first user.
#
# Steps:
#   1. docker compose down -v --remove-orphans + docker system prune
#   2. scripts/shell/run/build-and-run.sh  (build, lint, agent image, compose up, Ollama warmup, seed admin)
#   3. scripts/shell/ops/quick-setup.sh   (API-level user account + credential + connection setup)
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
# Step 1 — Tear down
# ---------------------------------------------------------------------------

log "Step 1: Tearing down services and pruning Docker..."
docker compose -f "$REPO_ROOT/docker-compose.yaml" -f "$REPO_ROOT/docker-compose.dev.yaml" \
  down -v --remove-orphans || error_exit "docker compose down failed"
docker system prune -f || error_exit "docker system prune failed"

# ---------------------------------------------------------------------------
# Step 2 — Build and run
# ---------------------------------------------------------------------------

log "Step 2: Running build-and-run.sh..."
bash "$SCRIPT_DIR/build-and-run.sh" || error_exit "build-and-run.sh failed"

# ---------------------------------------------------------------------------
# Step 3 — User account setup
# ---------------------------------------------------------------------------

if [[ "$SKIP_SETUP" -eq 1 ]]; then
  log "Step 3: Skipping quick-setup.sh (--skip-setup)"
else
  # Wait for the API to become healthy before hitting endpoints.
  # docker compose up -d returns immediately; the API needs time to boot.
  API_URL="${API_BASE_URL:-http://localhost:3000}"
  log "Step 3a: Waiting for API to be ready at $API_URL/health..."
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

  log "Step 3b: Running quick-setup.sh..."
  bash "$SCRIPT_DIR/../ops/quick-setup.sh" || error_exit "quick-setup.sh failed"
fi

log "Reset and run complete. Stack services are ready; Ollama warmup may still be running in background when enabled."
