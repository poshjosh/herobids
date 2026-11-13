#!/usr/bin/env bash
# register-fake-agents.sh — register N fake-agent Nomad jobs for a staging load test
# (Hetzner scale-path plan, task 5.1). STAGING ONLY.
#
# Each job runs the real agent image with a command override that launches the
# compiled fake agent (apps/worker/src/loadtest/fake-agent.ts). Jobs use the
# resource shape of a free-profile agent and the `herobids-agents` namespace, so
# the capacity controller reads them as genuine demand and scales out.
#
# SAFETY:
#   - Job IDs start with `loadtest-`, NEVER `agent-`. The worker's Nomad adapter
#     only manages `agent-` jobs, so it never stops or reconciles these.
#   - No constraints, affinities or spreads (the demand reader ignores constrained
#     jobs). No secrets beyond the staging REDIS_URL / DATABASE_URL passed as env.
#   - Clean up with scripts/loadtest/cleanup.sh when done.
#
# Run this ON the staging control plane (it talks to the local Nomad API), or set
# NOMAD_ADDR/NOMAD_TOKEN to reach a remote one.
#
# Usage:
#   register-fake-agents.sh --count N [options]
#
# Options:
#   --count N               Number of fake-agent jobs to register (required, 1..20000).
#   --start-index I         First index (default 1); jobs are loadtest-<I..I+N-1>.
#   --rate-per-sec R        Max job registrations per second (default 5).
#   --image IMG             Agent image (default ghcr.io/poshjosh/herobids-agent:latest).
#   --namespace NS          Nomad namespace (default herobids-agents).
#   --redis-url URL         REDIS_URL passed to each job (default from env REDIS_URL).
#   --database-url URL      DATABASE_URL passed to each job (optional; enables the DB query loop).
#   --heartbeat-ms MS       HEARTBEAT_INTERVAL_MS (default 5000).
#   --mem-mb MB             Task memory MB (default 256, free profile).
#   --mem-max-mb MB         Task memory max MB (default 512).
#   --cpu-mhz MHZ           Task CPU MHz (default 256).
#   --dry-run               Print what would be registered; make no API calls.
#   --help                  Show this help.
#
# Env:
#   NOMAD_ADDR   Nomad API base URL (default http://127.0.0.1:4646).
#   NOMAD_TOKEN  Nomad ACL token (read from /etc/nomad.d/acl-token if unset and readable).

set -euo pipefail

COUNT=""
START_INDEX=1
RATE_PER_SEC=5
IMAGE="ghcr.io/poshjosh/herobids-agent:latest"
NAMESPACE="herobids-agents"
REDIS_URL="${REDIS_URL:-}"
DATABASE_URL="${DATABASE_URL:-}"
HEARTBEAT_MS=5000
MEM_MB=256
MEM_MAX_MB=512
CPU_MHZ=256
DRY_RUN=false

NOMAD_ADDR="${NOMAD_ADDR:-http://127.0.0.1:4646}"
NOMAD_TOKEN="${NOMAD_TOKEN:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="${2:-}"; shift 2 ;;
    --start-index) START_INDEX="${2:-}"; shift 2 ;;
    --rate-per-sec) RATE_PER_SEC="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --redis-url) REDIS_URL="${2:-}"; shift 2 ;;
    --database-url) DATABASE_URL="${2:-}"; shift 2 ;;
    --heartbeat-ms) HEARTBEAT_MS="${2:-}"; shift 2 ;;
    --mem-mb) MEM_MB="${2:-}"; shift 2 ;;
    --mem-max-mb) MEM_MAX_MB="${2:-}"; shift 2 ;;
    --cpu-mhz) CPU_MHZ="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) sed -n '2,42p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "${COUNT}" =~ ^[0-9]+$ ]] || die "--count must be a positive integer"
(( COUNT >= 1 && COUNT <= 20000 )) || die "--count must be between 1 and 20000"
[[ "${START_INDEX}" =~ ^[0-9]+$ ]] || die "--start-index must be an integer"
[[ "${RATE_PER_SEC}" =~ ^[0-9]+$ ]] && (( RATE_PER_SEC >= 1 )) || die "--rate-per-sec must be >= 1"
[[ -n "${REDIS_URL}" ]] || die "--redis-url (or REDIS_URL) is required"
[[ "${NAMESPACE}" == "herobids-agents" ]] || echo "WARNING: namespace is ${NAMESPACE}, not herobids-agents" >&2

if [[ -z "${NOMAD_TOKEN}" && -r /etc/nomad.d/acl-token ]]; then
  NOMAD_TOKEN="$(cat /etc/nomad.d/acl-token)"
fi

# A conservative sleep between registrations to honour the rate cap.
SLEEP_BETWEEN="$(awk -v r="${RATE_PER_SEC}" 'BEGIN { printf "%.3f", 1.0 / r }')"

# build_job_json <job_id> — a minimal fake-agent Nomad job spec (as JSON for the
# /v1/jobs API). Command override runs the compiled fake agent. No constraints.
build_job_json() {
  local job_id="$1"
  local session_id="session-${job_id}"
  jq -n \
    --arg job "${job_id}" \
    --arg ns "${NAMESPACE}" \
    --arg image "${IMAGE}" \
    --arg agentId "${job_id}" \
    --arg sessionId "${session_id}" \
    --arg redis "${REDIS_URL}" \
    --arg database "${DATABASE_URL}" \
    --arg hb "${HEARTBEAT_MS}" \
    --argjson mem "${MEM_MB}" \
    --argjson memMax "${MEM_MAX_MB}" \
    --argjson cpu "${CPU_MHZ}" \
    '{
      Job: {
        ID: $job,
        Name: $job,
        Namespace: $ns,
        Type: "service",
        TaskGroups: [{
          Name: "fake-agent",
          Count: 1,
          Tasks: [{
            Name: "fake-agent",
            Driver: "docker",
            Config: {
              image: $image,
              command: "node",
              args: ["apps/worker/dist/loadtest/fake-agent.js"]
            },
            Env: ({
              AGENT_ID: $agentId,
              SESSION_ID: $sessionId,
              REDIS_URL: $redis,
              HEARTBEAT_INTERVAL_MS: $hb
            } + (if $database == "" then {} else { DATABASE_URL: $database } end)),
            Resources: { MemoryMB: $mem, MemoryMaxMB: $memMax, CPU: $cpu }
          }]
        }]
      }
    }'
}

nomad_put_job() {
  local job_id="$1" body="$2"
  curl -sS --fail --connect-timeout 10 --max-time 30 \
    -H "X-Nomad-Token: ${NOMAD_TOKEN}" \
    -X POST "${NOMAD_ADDR}/v1/jobs" \
    -d "${body}" >/dev/null
}

echo "Registering ${COUNT} fake-agent job(s) loadtest-${START_INDEX}..loadtest-$(( START_INDEX + COUNT - 1 )) at <=${RATE_PER_SEC}/s (namespace ${NAMESPACE})."
registered=0
for (( i = START_INDEX; i < START_INDEX + COUNT; i++ )); do
  job_id="loadtest-${i}"
  body="$(build_job_json "${job_id}")"
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] would register ${job_id}"
  else
    if nomad_put_job "${job_id}" "${body}"; then
      registered=$(( registered + 1 ))
    else
      echo "WARNING: failed to register ${job_id}" >&2
    fi
  fi
  sleep "${SLEEP_BETWEEN}"
done

echo "Done. Registered ${registered}/${COUNT} job(s). Clean up with scripts/loadtest/cleanup.sh."
