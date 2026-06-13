#!/bin/bash

# =============================================================================
# Herobids Build Script
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

# Load scripts/.env if present (provides ADMIN_EMAIL, ADMIN_PASSWORD, etc. for the seed admin ts script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../../.env"
if [[ -f "$ENV_FILE" ]]; then
    log "Loading env from scripts/.env..."
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
fi

log "Starting Herobids build process..."

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

# 5. Seed admin user (optional — skipped if ADMIN_EMAIL is not set)
log "Step 5: Seeding admin user..."
# Default to the local dev postgres URL if not explicitly provided
export DATABASE_URL="${DATABASE_URL:-postgres://herobids:herobids@localhost:5432/herobids}"
pnpm --filter scripts seed-admin || error_exit "Failed to seed admin user"

log "Build and run process completed successfully!"