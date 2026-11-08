#!/usr/bin/env bash
# smoke-test-browser-pool.sh — Browser-pool reachability gate for a deployed environment.
#
# Proves the path that agents use: the pool is registered in Nomad on a private
# address, the control plane and every ready agent node can reach it, a browser
# session can be acquired and released, and the admin health snapshot is fresh.
# Bug reports 2026/11/08 001 (public registration blocked by UFW) and 002 (no check).
#
# Checks:
#   1. Nomad registration: browser-pool has an entry on the private prefix.
#   2. Control plane -> pool: GET /json/version returns 200.
#   3. Session round trip: PUT /json/new returns an id, PUT /json/close/<id> returns 200.
#   4. Admin health: a browser-pool health snapshot exists and reports isAvailable.
#   5. Each ready agent node, host network: GET /json/version returns 200.
#   6. Each ready agent node, Docker bridge (what agent containers use): GET returns the version JSON.
#
# Usage:
#   infra/hetzner/scripts/smoke-test-browser-pool.sh --env staging <control-plane-ip>
#   infra/hetzner/scripts/smoke-test-browser-pool.sh --env production <control-plane-ip>
#
# Environment:
#   BROWSER_POOL_PRIVATE_PREFIX  Required address prefix for the pool (default: 10.0.0.).
#
# Exit code: 0 if all checks pass, 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_ssh_opts.sh"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 0
fi

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

CONTROL_IP="${1:-}"
if [[ -z "${CONTROL_IP}" || $# -gt 1 ]]; then
  echo "ERROR: usage: $0 --env <staging|production> <control-plane-ip>" >&2
  exit 1
fi

PRIVATE_PREFIX="${BROWSER_POOL_PRIVATE_PREFIX:-10.0.0.}"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf "  \033[32m✓ PASS\033[0m  %s\n" "$1"; }
fail() { FAILED=$((FAILED + 1)); printf "  \033[31m✗ FAIL\033[0m  %s — %s\n" "$1" "$2"; }

remote() { ssh ${SSH_OPTS} -o ConnectTimeout=10 "root@$1" "${@:2}"; }

echo ""
echo "========================================"
echo " Browser Pool Smoke Test — ${HEROBIDS_ENV}"
echo " Control plane: ${CONTROL_IP}"
echo "========================================"
echo ""

# ─── 1. Nomad registration ───────────────────────────────────────────────────

echo "── 1. Nomad Registration ──"

POOL_ENTRIES=$(remote "${CONTROL_IP}" 'bash -s' <<'REMOTE' || true
T=$(cat /etc/nomad.d/acl-token 2>/dev/null || true)
curl -sf -m 10 -H "X-Nomad-Token: ${T}" http://127.0.0.1:4646/v1/service/browser-pool \
  | jq -r '.[] | "\(.Address):\(.Port)"'
REMOTE
)

if [[ -z "${POOL_ENTRIES}" ]]; then
  fail "browser-pool registered in Nomad" "no service entries — pool is not running or not registered"
  POOL_HOSTPORT=""
else
  POOL_HOSTPORT="$(echo "${POOL_ENTRIES}" | head -1)"
  pass "browser-pool registered in Nomad at ${POOL_HOSTPORT}"
  while IFS= read -r entry; do
    addr="${entry%:*}"
    if [[ "${addr}" == "${PRIVATE_PREFIX}"* ]]; then
      pass "registered on private address (${addr})"
    else
      fail "registered on private address" "${entry} is outside ${PRIVATE_PREFIX}* — agents and firewall rules assume the private network (bug 2026/11/08 001)"
    fi
  done <<< "${POOL_ENTRIES}"
fi

if [[ -z "${POOL_HOSTPORT}" ]]; then
  echo ""
  echo "========================================"
  printf " Passed: %d  Failed: %d\n" "${PASSED}" "${FAILED}"
  echo " Status:  FAIL ✗ (no pool address to probe)"
  echo "========================================"
  exit 1
fi

POOL_URL="http://${POOL_HOSTPORT}"

# ─── 2. Control plane -> pool ────────────────────────────────────────────────

echo "── 2. Control Plane Reachability ──"

CP_CODE=$(remote "${CONTROL_IP}" "curl -s -m 5 -o /dev/null -w '%{http_code}' ${POOL_URL}/json/version" || true)
if [[ "${CP_CODE}" == "200" ]]; then
  pass "control plane -> ${POOL_HOSTPORT} /json/version = 200"
else
  fail "control plane -> ${POOL_HOSTPORT}" "HTTP ${CP_CODE:-none} (timeout or refused — check the pool node's UFW rules)"
fi

# ─── 3. Session round trip ───────────────────────────────────────────────────

echo "── 3. Session Round Trip ──"

SESSION_ID=$(remote "${CONTROL_IP}" "curl -s -m 10 -X PUT ${POOL_URL}/json/new | jq -r '.id // empty'" || true)
if [[ -n "${SESSION_ID}" ]]; then
  pass "session acquired (PUT /json/new)"
  CLOSE_CODE=$(remote "${CONTROL_IP}" "curl -s -m 10 -o /dev/null -w '%{http_code}' -X PUT ${POOL_URL}/json/close/${SESSION_ID}" || true)
  # 404: Browserless already dropped the session because no client attached (it is absent from /json/list).
  if [[ "${CLOSE_CODE}" == "200" ]]; then
    pass "session released (PUT /json/close)"
  elif [[ "${CLOSE_CODE}" == "404" ]]; then
    pass "session already released by Browserless (PUT /json/close = 404, no client attached)"
  else
    fail "session released" "HTTP ${CLOSE_CODE:-none} on PUT /json/close"
  fi
else
  fail "session acquired (PUT /json/new)" "no session id returned — this is the browser_pool.timeout path agents see"
fi

# ─── 4. Admin health snapshot ────────────────────────────────────────────────

echo "── 4. Admin Health Snapshot ──"

HEALTH_AVAILABLE=$(remote "${CONTROL_IP}" 'bash -s' <<'REMOTE' || true
key=$(docker exec herobids-redis-1 redis-cli --scan --pattern 'herobids:server-health:browser-pool:*' | head -1)
[ -n "${key}" ] || exit 0
docker exec herobids-redis-1 redis-cli GET "${key}" | jq -r '.metadata.isAvailable // "unknown"'
REMOTE
)

if [[ -z "${HEALTH_AVAILABLE}" ]]; then
  fail "browser-pool health snapshot" "no herobids:server-health:browser-pool:* key — admin Browser Pool panel will be empty"
elif [[ "${HEALTH_AVAILABLE}" == "true" ]]; then
  pass "browser-pool health snapshot present, isAvailable = true"
else
  fail "browser-pool health snapshot" "present but isAvailable = ${HEALTH_AVAILABLE}"
fi

# ─── 5 + 6. Agent nodes ──────────────────────────────────────────────────────

echo "── 5. Agent Node Reachability ──"

AGENTS=$(remote "${CONTROL_IP}" 'bash -s' <<'REMOTE' || true
T=$(cat /etc/nomad.d/acl-token 2>/dev/null || true)
H="X-Nomad-Token: ${T}"
curl -sf -m 10 -H "$H" http://127.0.0.1:4646/v1/nodes \
  | jq -r '.[] | select(.NodeClass=="agent" and .Status=="ready" and .SchedulingEligibility=="eligible") | .ID' \
  | while read -r id; do
      curl -sf -m 10 -H "$H" "http://127.0.0.1:4646/v1/node/${id}" \
        | jq -r '"\(.Name) \(.Attributes["unique.network.ip-address"])"'
    done
REMOTE
)

if [[ -z "${AGENTS}" ]]; then
  fail "ready agent nodes" "none found in Nomad — nothing can use the pool"
fi

while IFS= read -r line <&3; do
  [[ -n "${line}" ]] || continue
  name="${line% *}"
  ip="${line##* }"

  # Local delivery to a node's own public address can succeed while remote traffic is blocked,
  # so this check is only conclusive once the pool is registered on the private address.
  host_code=$(remote "${ip}" "curl -s -m 5 -o /dev/null -w '%{http_code}' ${POOL_URL}/json/version" || true)
  if [[ "${host_code}" == "200" ]]; then
    pass "${name} (${ip}) host -> pool = 200"
  else
    fail "${name} (${ip}) host -> pool" "HTTP ${host_code:-none} (agent node UFW must allow port ${POOL_HOSTPORT##*:} from the private subnet)"
  fi

  # UFW rules allow the default bridge (docker0) only. Fail if running agents use another network.
  agent_net=$(remote "${ip}" "docker ps --filter name=^agent- --format '{{.Names}}' | head -1 | xargs -r -I{} docker inspect -f '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}}{{end}}' {}" || true)
  if [[ -n "${agent_net}" && "${agent_net}" != "bridge" ]]; then
    fail "${name} (${ip}) agent network" "running agents use network '${agent_net}', but the firewall rules allow only bridge (docker0)"
    continue
  fi

  bridge_out=$(remote "${ip}" "docker pull -q busybox:1.36 >/dev/null 2>&1; timeout 60 docker run --rm --pull=never --network bridge busybox:1.36 wget -q -T 5 -O - ${POOL_URL}/json/version 2>&1" | tr '\n' ' ' || true)
  if echo "${bridge_out}" | grep -q 'webSocketDebuggerUrl'; then
    pass "${name} (${ip}) Docker bridge -> pool"
  else
    fail "${name} (${ip}) Docker bridge -> pool" "agent containers cannot reach the pool: ${bridge_out:0:160}"
  fi
done 3<<< "${AGENTS}"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
printf "  Passed:  %d\n" "${PASSED}"
printf "  Failed:  %d\n" "${FAILED}"
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
