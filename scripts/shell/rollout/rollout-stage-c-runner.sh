#!/usr/bin/env bash
# rollout-stage-c-runner.sh — Orchestrates infrastructure, services, and Stage C verification.
#
# This script:
#   1. Starts Docker infrastructure (postgres + redis)
#   2. Runs DB migrations
#   3. Starts API and worker processes
#   4. Waits for API readiness
#   5. Discovers a running shadow instance
#   6. Executes rollout-stage-c.sh against that instance
#
# Prerequisites:
#   - Docker daemon running
#   - Environment configured (scripts/.env or shell exports)
#   - pnpm deps installed (pnpm install)
#   - Packages built (pnpm build)
#
# Usage:
#   ./scripts/shell/rollout/rollout-stage-c-runner.sh --shadow    # default: target a shadow instance
#   ./scripts/shell/rollout/rollout-stage-c-runner.sh --live      # target a live instance (real money)
#   ./scripts/shell/rollout/rollout-stage-c-runner.sh             # same as --shadow
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT_DIR"

# --- Parse flags (matches rollout-stage-b.sh convention) ---
SHADOW_MODE=false
LIVE_MODE=false
for arg in "$@"; do
  case "$arg" in
    --shadow) SHADOW_MODE=true ;;
    --live)   LIVE_MODE=true ;;
    *) echo "Unknown argument: $arg" >&2; echo "Usage: $0 [--shadow|--live]" >&2; exit 1 ;;
  esac
done

if [[ "$SHADOW_MODE" == "true" && "$LIVE_MODE" == "true" ]]; then
  echo "Cannot use --shadow and --live together" >&2; exit 1
fi

# Default to shadow if no flag provided
if [[ "$SHADOW_MODE" == "false" && "$LIVE_MODE" == "false" ]]; then
  SHADOW_MODE=true
fi

if [[ "$LIVE_MODE" == "true" ]]; then
  TARGET_MODE="live"
else
  TARGET_MODE="shadow"
fi

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[runner]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓ runner]${NC} $1"; }
warn() { echo -e "${YELLOW}[runner]${NC} $1"; }
die()  { echo -e "${RED}[✗ runner]${NC} $1" >&2; exit 1; }

API_PORT="${API_PORT:-3000}"
API_URL="http://localhost:${API_PORT}"
API_READY_TIMEOUT=30
API_PID=""
WORKER_PID=""

# --- Cleanup on exit ---
cleanup() {
  log "Cleaning up background processes..."
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    log "  Stopped API (pid=$API_PID)"
  fi
  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
    log "  Stopped worker (pid=$WORKER_PID)"
  fi
}
trap cleanup EXIT

# --- Require tools ---
command -v docker >/dev/null 2>&1 || die "docker is required but not installed"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required but not installed"
command -v jq >/dev/null 2>&1 || die "jq is required but not installed"
command -v curl >/dev/null 2>&1 || die "curl is required but not installed"

# --- Load environment ---
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
  log "Loaded environment from .env"
fi

echo ""
echo "=== Stage C Runner — Infrastructure + Verification ==="
echo ""

# ============================================================
# STEP 1: Install deps & build
# ============================================================
log "STEP 1: Installing dependencies and building..."
pnpm install 2>&1 | sed 's/^/  /' || die "pnpm install failed"
pnpm build 2>&1 | sed 's/^/  /' || die "pnpm build failed"
ok "Install & build complete"
echo ""

# ============================================================
# STEP 2: Start infrastructure (postgres + redis)
# ============================================================
log "STEP 2: Starting Docker infrastructure..."
docker compose up -d 2>&1 | sed 's/^/  /'
ok "Docker containers started"
echo ""

# ============================================================
# STEP 3: Run DB migrations
# ============================================================
log "STEP 3: Running database migrations..."
pnpm --filter @herobids/db run db:migrate 2>&1 | sed 's/^/  /'
ok "Migrations complete"
echo ""

# ============================================================
# STEP 4: Start API + worker in background
# ============================================================
log "STEP 4: Starting API and worker..."

pnpm --filter @herobids/api run start > /tmp/herobids-api.log 2>&1 &
API_PID=$!
log "  API started (pid=$API_PID, log=/tmp/herobids-api.log)"

pnpm --filter @herobids/worker run start > /tmp/herobids-worker.log 2>&1 &
WORKER_PID=$!
log "  Worker started (pid=$WORKER_PID, log=/tmp/herobids-worker.log)"

echo ""

# ============================================================
# STEP 5: Wait for API readiness
# ============================================================
log "STEP 5: Waiting for API to be ready at $API_URL..."
elapsed=0
while [[ $elapsed -lt $API_READY_TIMEOUT ]]; do
  if curl -sf "$API_URL/health" >/dev/null 2>&1; then
    ok "API is ready (${elapsed}s)"
    curl -sf "$API_URL/health" | jq . | sed 's/^/  /'
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [[ $elapsed -ge $API_READY_TIMEOUT ]]; then
  warn "API did not respond within ${API_READY_TIMEOUT}s — checking logs:"
  tail -20 /tmp/herobids-api.log | sed 's/^/  /'
  die "API not ready — cannot proceed"
fi
echo ""

# ============================================================
# STEP 6: Find a running instance matching TARGET_MODE
# ============================================================
log "STEP 6: Discovering running $TARGET_MODE instance..."

INSTANCES_RESPONSE=$(curl -sf "$API_URL/instances" 2>/dev/null || echo '{"instances":[]}')
RUNNING_INSTANCE=$(echo "$INSTANCES_RESPONSE" | jq -r --arg mode "$TARGET_MODE" '
  [.instances[] | select(.status == "running" and .config.execution.mode == $mode)] | first // empty
')

if [[ -z "$RUNNING_INSTANCE" || "$RUNNING_INSTANCE" == "null" ]]; then
  log "  No running $TARGET_MODE instances found — looking for a stopped one to start..."

  STOPPED_INSTANCE_ID=$(echo "$INSTANCES_RESPONSE" | jq -r --arg mode "$TARGET_MODE" '
    [.instances[] | select((.status == "stopped" or .status == "crashed") and .config.execution.mode == $mode)] | first | .id // empty
  ')

  if [[ -z "$STOPPED_INSTANCE_ID" || "$STOPPED_INSTANCE_ID" == "null" ]]; then
    log "  No $TARGET_MODE instances found at all. Listing all instances:"
    echo "$INSTANCES_RESPONSE" | jq '.instances[] | {id, status, mode: .config.execution.mode}' | sed 's/^/  /'
    die "No $TARGET_MODE instance available — create one first."
  fi

  log "  Starting stopped instance $STOPPED_INSTANCE_ID..."
  START_HTTP=$(curl -s -o /tmp/herobids-start-response.json -w "%{http_code}" -X POST "$API_URL/instances/$STOPPED_INSTANCE_ID/start") || true
  START_RESPONSE=$(cat /tmp/herobids-start-response.json 2>/dev/null || echo "")
  if [[ "$START_HTTP" != "200" ]]; then
    warn "  Start request failed (HTTP $START_HTTP): $START_RESPONSE"
    die "Could not start instance $STOPPED_INSTANCE_ID"
  fi
  ok "  Start request accepted for $STOPPED_INSTANCE_ID"

  # Wait for instance to become running
  log "  Waiting for instance to reach running state..."
  start_wait=0
  while [[ $start_wait -lt 30 ]]; do
    INST_STATUS=$(curl -sf "$API_URL/instances/$STOPPED_INSTANCE_ID" 2>/dev/null | jq -r '.status // "unknown"')
    if [[ "$INST_STATUS" == "running" ]]; then
      break
    fi
    sleep 2
    start_wait=$((start_wait + 2))
  done

  if [[ "$INST_STATUS" != "running" ]]; then
    warn "  Instance did not reach running state within 30s (status=$INST_STATUS)"
    tail -20 /tmp/herobids-worker.log | sed 's/^/  /'
    die "Instance $STOPPED_INSTANCE_ID failed to start"
  fi

  INSTANCE_ID="$STOPPED_INSTANCE_ID"
  INSTANCE_MODE="$TARGET_MODE"
  INSTANCE_STATUS="running"
  ok "Instance $INSTANCE_ID is now running"
else
  INSTANCE_ID=$(echo "$RUNNING_INSTANCE" | jq -r '.id')
  INSTANCE_MODE=$(echo "$RUNNING_INSTANCE" | jq -r '.config.execution.mode // "unknown"')
  INSTANCE_STATUS=$(echo "$RUNNING_INSTANCE" | jq -r '.status')
  ok "Found running instance: $INSTANCE_ID (mode=$INSTANCE_MODE)"
fi

if [[ "$INSTANCE_MODE" == "live" ]]; then
  warn "  ⚠️  Instance is in LIVE mode — real orders may be placed during restart cycles"
fi
echo ""

# ============================================================
# STEP 7: Run Stage C verification
# ============================================================
log "STEP 7: Running Stage C verification against instance $INSTANCE_ID..."
echo ""

"$SCRIPT_DIR/rollout-stage-c.sh" "$INSTANCE_ID"
STAGE_C_EXIT=$?

echo ""
if [[ $STAGE_C_EXIT -eq 0 ]]; then
  ok "Stage C runner completed successfully"
else
  die "Stage C verification failed (exit=$STAGE_C_EXIT)"
fi
