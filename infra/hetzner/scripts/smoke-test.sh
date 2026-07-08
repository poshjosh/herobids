#!/usr/bin/env bash
# smoke-test.sh — Automated multi-environment smoke test for Herobids.
#
# Runs scriptable health checks against a deployed environment. Browser-only
# checks (OAuth, billing page UI, Telegram interaction) are skipped with a
# clear message.
#
# Usage:
#   infra/hetzner/scripts/smoke-test.sh [--env <staging|production>] [<server-ip>]
#   infra/hetzner/scripts/smoke-test.sh --env staging
#   infra/hetzner/scripts/smoke-test.sh --env production
#   infra/hetzner/scripts/smoke-test.sh 1.2.3.4          # explicit IP, defaults to production
#
# Environment:
#   HEROBIDS_ENV   Deployment environment: staging | production (default: production).
#
# Exit code: 0 if all automated checks pass, 1 if any check fails.

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Parse arguments ─────────────────────────────────────────────────────────

SERVER_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "${SERVER_IP}" ]]; then
        SERVER_IP="$1"
      else
        echo "ERROR: Unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# ─── Resolve server IP ───────────────────────────────────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: Could not determine server IP." >&2
  echo "  Run provision.sh --env ${HEROBIDS_ENV} first, or pass the IP explicitly: $0 <ip>" >&2
  exit 1
fi

# ─── State tracking ──────────────────────────────────────────────────────────

PASSED=0
FAILED=0
SKIPPED=0

pass()  { PASSED=$((PASSED + 1)); printf "  \033[32m✓ PASS\033[0m  %s\n" "$1"; }
fail()  { FAILED=$((FAILED + 1)); printf "  \033[31m✗ FAIL\033[0m  %s — %s\n" "$1" "$2"; }
skip()  { SKIPPED=$((SKIPPED + 1)); printf "  \033[33m⊘ SKIP\033[0m  %s — %s\n" "$1" "$2"; }

# ─── Header ──────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Smoke Test — ${HEROBIDS_ENV}"
echo " Server:    ${SERVER_IP}"
echo "========================================"
echo ""

# ─── Check 1: SSH connectivity ───────────────────────────────────────────────

echo "── 1. SSH Connectivity ──"

if ssh ${SSH_OPTS} -o ConnectTimeout=10 "root@${SERVER_IP}" 'echo ok' &>/dev/null; then
  pass "SSH connection established"
else
  fail "SSH connection" "cannot reach server — aborting remaining checks"
  echo ""
  echo "========================================"
  echo " Result: 1 passed, 1 failed, ${SKIPPED} skipped"
  echo " Status:  FAIL"
  echo "========================================"
  exit 1
fi

# ─── Check 2: Docker containers running ──────────────────────────────────────

echo "── 2. Docker Containers ──"

CONTAINERS=$(ssh ${SSH_OPTS} "root@${SERVER_IP}" \
  'docker ps --format "{{.Names}}" 2>&1' || true)

for svc in caddy api web worker postgres redis; do
  if echo "${CONTAINERS}" | grep -q "${svc}"; then
    pass "Container '${svc}' is running"
  else
    fail "Container '${svc}'" "not running"
  fi
done

# ─── Check 3: API health endpoint ────────────────────────────────────────────

echo "── 3. API Health ──"

HEALTH_BODY=$(ssh ${SSH_OPTS} "root@${SERVER_IP}" \
  'curl -sf -L http://localhost:3000/health 2>&1' || true)

if [[ -n "${HEALTH_BODY}" ]]; then
  pass "API /health responded"
else
  fail "API /health" "no response — check logs.sh --env ${HEROBIDS_ENV} -- api"
fi

# ─── Check 4: Worker logs (no guard failures) ────────────────────────────────

echo "── 4. Worker Boot ──"

# Include both overlay files so the command works regardless of which
# overlay the server was last deployed with.
ALL_COMPOSE="-f /opt/herobids/docker-compose.yaml -f /opt/herobids/docker-compose.prod.yaml -f /opt/herobids/docker-compose.staging.yaml"

WORKER_LOG=$(ssh ${SSH_OPTS} "root@${SERVER_IP}" \
  "docker compose ${ALL_COMPOSE} logs --tail=200 worker 2>&1" || true)

if echo "${WORKER_LOG}" | grep -qE 'strategy\.error|strategy\.fatal|strategy\.config_invalid'; then
  fail "Worker logs" "guard failures detected (strategy.error/fatal/config_invalid)"
else
  pass "Worker logs — no guard failures"
fi

# Check NODE_ENV appears in logs (any format)
if echo "${WORKER_LOG}" | grep -qi 'NODE_ENV'; then
  pass "Worker NODE_ENV is configured"
else
  fail "Worker NODE_ENV" "no NODE_ENV found in recent logs"
fi

# ─── Check 5: Database migrations ────────────────────────────────────────────

echo "── 5. Database Migrations ──"

MIGRATE_OUT=$(ssh ${SSH_OPTS} "root@${SERVER_IP}" \
  "cd /opt/herobids && timeout 30 docker compose ${ALL_COMPOSE} run --rm migrate 2>&1" || true)

if echo "${MIGRATE_OUT}" | grep -qiE 'no migrations|already applied|up to date'; then
  pass "DB migrations — up to date"
elif echo "${MIGRATE_OUT}" | grep -qi 'error\|fatal\|failed'; then
  fail "DB migrations" "migration error — check logs"
elif [[ -z "${MIGRATE_OUT}" ]]; then
  fail "DB migrations" "no output — timed out or service not running"
else
  pass "DB migrations — completed"
fi

# ─── Skipped checks ──────────────────────────────────────────────────────────

echo ""
echo "── Skipped (requires browser or manual interaction) ──"

skip "OAuth redirect flow"   "requires browser login at the app domain"
skip "Billing page UI"       "requires browser login and navigation"
skip "Telegram webhook"      "requires bot configuration and message send"

# ─── Summary ─────────────────────────────────────────────────────────────────

TOTAL=$((PASSED + FAILED + SKIPPED))
echo ""
echo "========================================"
printf "  Passed:  %d\n" "${PASSED}"
printf "  Failed:  %d\n" "${FAILED}"
printf "  Skipped: %d\n" "${SKIPPED}"
echo "========================================"

if [[ "${FAILED}" -eq 0 ]]; then
  echo " Status:  PASS ✓"
  echo "========================================"
  exit 0
else
  echo " Status:  FAIL ✗"
  echo "========================================"
  exit 1
fi
