#!/usr/bin/env bash
# rollout-check-prerequisites.sh — Verify all prerequisites for Phase 4 live rollout.
# Run from the monorepo root: ./scripts/shell/rollout-check-prerequisites.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)) || true; }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)) || true; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; ((WARN++)) || true; }

echo "=== Phase 4 Live Rollout — Prerequisite Check ==="
echo ""

# --- 1. Runtime tools ---
echo "1. Runtime tools"
command -v node >/dev/null 2>&1 && pass "node $(node --version)" || fail "node not found"
command -v pnpm >/dev/null 2>&1 && pass "pnpm $(pnpm --version)" || fail "pnpm not found"
command -v docker >/dev/null 2>&1 && pass "docker $(docker --version | awk '{print $3}')" || fail "docker not found"
command -v docker-compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1 && pass "docker compose available" || fail "docker compose not found"
echo ""

# --- 2. Node version ---
echo "2. Node version (>=22)"
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -ge 22 ]]; then
  pass "Node $NODE_MAJOR >= 22"
else
  fail "Node $NODE_MAJOR < 22 — requires >=22"
fi
echo ""

# --- 3. Environment variables ---
echo "3. Environment variables"

# Required for all stages
if [[ -n "${CREDENTIAL_ENCRYPTION_KEY:-}" ]]; then
  if [[ ${#CREDENTIAL_ENCRYPTION_KEY} -eq 64 ]]; then
    pass "CREDENTIAL_ENCRYPTION_KEY is set (64 hex chars)"
  else
    fail "CREDENTIAL_ENCRYPTION_KEY is set but wrong length (${#CREDENTIAL_ENCRYPTION_KEY} chars, need 64 hex)"
  fi
else
  fail "CREDENTIAL_ENCRYPTION_KEY not set — run: export CREDENTIAL_ENCRYPTION_KEY=\$(openssl rand -hex 32)"
fi

# Stage A (testnet)
if [[ -n "${HYPERLIQUID_TESTNET_API_KEY:-}" ]]; then
  pass "HYPERLIQUID_TESTNET_API_KEY is set"
else
  warn "HYPERLIQUID_TESTNET_API_KEY not set (needed for Stage A)"
fi

if [[ -n "${HYPERLIQUID_TESTNET_SECRET:-}" ]]; then
  pass "HYPERLIQUID_TESTNET_SECRET is set"
else
  warn "HYPERLIQUID_TESTNET_SECRET not set (needed for Stage A)"
fi

# Stage B (production)
if [[ -n "${HYPERLIQUID_API_KEY:-}" ]]; then
  pass "HYPERLIQUID_API_KEY is set"
else
  warn "HYPERLIQUID_API_KEY not set (needed for Stage B)"
fi

if [[ -n "${HYPERLIQUID_SECRET:-}" ]]; then
  pass "HYPERLIQUID_SECRET is set"
else
  warn "HYPERLIQUID_SECRET not set (needed for Stage B)"
fi
echo ""

# --- 4. Infrastructure connectivity ---
echo "4. Infrastructure"

# Docker running?
if docker info >/dev/null 2>&1; then
  pass "Docker daemon running"
else
  fail "Docker daemon not running"
fi

# Postgres reachable?
if docker compose ps 2>/dev/null | grep -q postgres; then
  pass "Postgres container exists"
  if pg_isready -h localhost -p 5432 -U herobids >/dev/null 2>&1; then
    pass "Postgres accepting connections"
  else
    warn "Postgres container exists but not accepting connections (might need: docker compose up -d)"
  fi
else
  warn "Postgres container not running (will be started by rollout scripts)"
fi

# Redis reachable?
if docker compose ps 2>/dev/null | grep -q redis; then
  pass "Redis container exists"
else
  warn "Redis container not running (will be started by rollout scripts)"
fi
echo ""

# --- 5. Build state ---
echo "5. Build state"
if [[ -d "node_modules" ]]; then
  pass "node_modules exists"
else
  fail "node_modules missing — run: pnpm install"
fi

if [[ -f "packages/domain/dist/index.js" ]]; then
  pass "packages built (domain/dist exists)"
else
  warn "packages not built — rollout scripts will run pnpm build"
fi
echo ""

# --- 6. Tests ---
echo "6. Test suite"
echo "   (Run 'pnpm test' separately to verify all tests pass)"
echo ""

# --- Summary ---
echo "=== Summary ==="
echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}  ${YELLOW}Warnings: $WARN${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Fix failures before proceeding with live rollout.${NC}"
  exit 1
elif [[ $WARN -gt 0 ]]; then
  echo -e "${YELLOW}Warnings present — some stages may not be runnable.${NC}"
  exit 0
else
  echo -e "${GREEN}All prerequisites met. Ready for live rollout.${NC}"
  exit 0
fi
