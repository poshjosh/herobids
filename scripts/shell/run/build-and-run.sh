#!/bin/bash

# =============================================================================
# HeroBids Build Script
# =============================================================================

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Error handling function
error_exit() {
    log "ERROR: $1"
    exit "${2:-1}"
}

# Check if pnpm is available
if ! command -v pnpm &> /dev/null; then
    error_exit "pnpm could not be found. Please install pnpm (https://pnpm.io/installation)"
fi

# Check if docker is available
if ! command -v docker &> /dev/null; then
    error_exit "docker could not be found. Please install Docker"
fi

# Load .env.ops.dev if present (provides ADMIN_EMAIL, ADMIN_PASSWORD, etc. for the seed admin ts script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.ops.dev"
if [[ -f "$ENV_FILE" ]]; then
    log "Loading env from .env.ops.dev..."
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
fi

PRELOAD_OLLAMA_MODELS="${PRELOAD_OLLAMA_MODELS:-1}"

should_preload_ollama() {
    case "$PRELOAD_OLLAMA_MODELS" in
        1|true|TRUE|yes|YES)
            return 0
            ;;
        0|false|FALSE|no|NO)
            return 1
            ;;
        *)
            log "WARNING: Unknown PRELOAD_OLLAMA_MODELS='$PRELOAD_OLLAMA_MODELS'; expected 1/0 or true/false. Defaulting to enabled."
            return 0
            ;;
    esac
}

log "Starting HeroBids build process..."

# 1. Run pnpm build
log "Step 1: Running pnpm build..."
pnpm build || error_exit "Failed to run pnpm build"

# 2. Run pnpm lint
log "Step 2: Running pnpm lint..."
pnpm lint || error_exit "Failed to run pnpm lint"

# 3. Build agent Docker image
log "Step 3: Building agent Docker image..."
docker build -f docker/Dockerfile.agent -t herobids-agent:latest . || error_exit "Failed to build agent Docker image"

# 4. Start services with docker compose
log "Step 4: Building and starting services with docker compose..."
docker compose -f docker-compose.yaml -f docker-compose.dev.yaml up -d --build || error_exit "Failed to start services with docker compose"

# 4b. Pre-load Ollama models in the background so the first agent tick avoids a cold start.
# This is a best-effort local-dev optimization and must never fail the stack startup.
if should_preload_ollama; then
    log "Step 4b: Pre-loading Ollama models in background..."
    (
        bash "$SCRIPT_DIR/load-ollama-agents.sh" || log "WARNING: Ollama model pre-load finished with errors (see warnings above)."
    ) &
else
    log "Step 4b: Skipping Ollama model pre-load (PRELOAD_OLLAMA_MODELS=$PRELOAD_OLLAMA_MODELS)."
fi

# 5. Seed admin user (optional — skipped if ADMIN_EMAIL is not set)
log "Step 5: Seeding admin user..."
# Default to the local dev postgres URL if not explicitly provided
export DATABASE_URL="${DATABASE_URL:-postgres://herobids:herobids@localhost:5432/herobids}"
pnpm --filter scripts seed-admin || error_exit "Failed to seed admin user"

if should_preload_ollama; then
    log "Build and run process completed successfully! Services are up; Ollama warmup continues in background."
else
    log "Build and run process completed successfully!"
fi