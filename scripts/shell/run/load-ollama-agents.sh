#!/bin/bash
# load-ollama-agents.sh — Pre-load Ollama models into memory before agents start.
#
# Calling this after the stack is up ensures the first agent tick does not time out
# waiting for a cold model load. Safe to call when models are already loaded — Ollama
# resets the keep_alive timer and returns immediately.
#
# Usage:
#   scripts/shell/run/load-ollama-agents.sh              # blocks until all models loaded
#   scripts/shell/run/load-ollama-agents.sh &            # fire-and-forget

set -uo pipefail  # catch undefined vars and pipe failures, but NOT -e (errors are warnings here)

OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-60m}"
CONNECT_TIMEOUT=5
STARTUP_WAIT_TIMEOUT="${OLLAMA_STARTUP_WAIT_TIMEOUT:-90}"
STARTUP_WAIT_INTERVAL=2
MODEL_LOAD_TIMEOUT=300  # 5 min — large models (24 GB) can take >2 min on first load

MODELS=(
  "qwen3.6:35b-a3b-q4_K_M"
  "qwen3-coder:30b"
)

log()  { echo "[load-ollama] $1"; }
warn() { echo "[load-ollama] WARNING: $1" >&2; }

# ---------------------------------------------------------------------------
# Wait briefly for Ollama to come up before attempting any model loads
# ---------------------------------------------------------------------------
wait_for_ollama() {
  local elapsed=0

  until curl -sf --max-time "$CONNECT_TIMEOUT" "$OLLAMA_BASE_URL/api/tags" > /dev/null 2>&1; do
    if [[ $elapsed -ge $STARTUP_WAIT_TIMEOUT ]]; then
      return 1
    fi

    if [[ $elapsed -eq 0 ]]; then
      log "Waiting for Ollama at $OLLAMA_BASE_URL to become ready..."
    fi

    sleep "$STARTUP_WAIT_INTERVAL"
    elapsed=$((elapsed + STARTUP_WAIT_INTERVAL))
  done

  if [[ $elapsed -gt 0 ]]; then
    log "Ollama became ready after ~${elapsed}s."
  fi

  return 0
}

if ! wait_for_ollama; then
  warn "Ollama did not become ready at $OLLAMA_BASE_URL within ${STARTUP_WAIT_TIMEOUT}s — skipping model pre-load."
  warn "Agents will load models on demand; the first tick may time out on a cold model."
  exit 0
fi

log "Ollama available at $OLLAMA_BASE_URL. Pre-loading ${#MODELS[@]} model(s) with keep_alive=${KEEP_ALIVE}..."

# ---------------------------------------------------------------------------
# Load a single model; warn on failure without aborting the loop
# ---------------------------------------------------------------------------
load_model() {
  local model="$1"
  local response exit_code

  response=$(curl -s --max-time "$MODEL_LOAD_TIMEOUT" \
    "$OLLAMA_BASE_URL/api/generate" \
    -d "{\"model\":\"$model\",\"keep_alive\":\"$KEEP_ALIVE\"}" 2>&1)
  exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    warn "curl failed for model '$model' (exit $exit_code — timeout or network error)."
    return 1
  fi

  # Ollama returns HTTP 200 even for errors (e.g. model not found) — inspect the body.
  if echo "$response" | grep -q '"error"'; then
    local error_msg
    # Try jq first; fall back to grep+sed for minimal dependencies
    if command -v jq > /dev/null 2>&1; then
      error_msg=$(echo "$response" | jq -r '.error // empty' 2>/dev/null | head -1)
    else
      error_msg=$(echo "$response" | grep -o '"error":[^,}]*' | head -1 | sed 's/"error"://;s/"//g')
    fi
    warn "Ollama returned an error for model '$model': ${error_msg:-unknown}"
    return 1
  fi

  log "Model '$model' loaded (keep_alive=${KEEP_ALIVE})."
  return 0
}

# ---------------------------------------------------------------------------
# Load models sequentially — Ollama serialises concurrent requests anyway
# ---------------------------------------------------------------------------
failed=0
for model in "${MODELS[@]}"; do
  log "Loading: $model"
  load_model "$model" || failed=$((failed + 1))
done

if [[ $failed -gt 0 ]]; then
  warn "$failed model(s) failed to pre-load. Check warnings above."
  exit 1
fi

log "All models pre-loaded successfully."