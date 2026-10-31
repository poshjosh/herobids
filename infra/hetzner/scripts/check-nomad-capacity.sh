#!/usr/bin/env bash
# check-nomad-capacity.sh — Poll Nomad API and compute free cluster headroom.
#
# Computes free allocatable memory and available agent slots across all
# ready Nomad client nodes in the cluster. Used by scale-out.sh to decide
# whether to provision additional agent nodes.
#
# Usage:
#   check-nomad-capacity.sh [--help] [--dry-run] [--json]
#
# Options:
#   --help       Show this help message.
#   --dry-run    Log what would be done without side effects.
#   --json       Output results as JSON (default: human-readable to stderr, key=value to stdout).
#
# Output (stdout):
#   When --json:  {"free_memory_mb": <int>, "free_slots": <int>, "total_memory_mb": <int>, "ready_nodes": <int>, "agent_memory_reservation_mb": <int>}
#   Otherwise:    key=value lines for sourcing by other scripts.
#
# Exit codes:
#   0  Success (even if capacity is low — check free_slots / free_memory_mb).
#   1  Nomad API unreachable or returned an error.
#   2  No ready Nomad client nodes found.
#
# Environment (see scale-common.sh for full list):
#   NOMAD_ADDR                          Nomad server HTTP API base URL.
#   NOMAD_AGENT_MEMORY_RESERVATION_MB   Memory reservation per agent slot for slot count.
#   NOMAD_AGENT_CPU_RESERVATION_MHZ     CPU reservation per agent slot for slot count (Nomad scheduler units).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"
source "${SCRIPT_DIR}/capacity-demand.sh"

# Exit 2 from this script means only "no ready agent nodes". A bad operator knob is this
# script's failure, so it exits 1; the subshell stops require_uint's exit 2 at the boundary.
if ! (validate_scale_numeric_env); then
  die "Invalid autoscale numeric configuration (see FATAL line above). Refusing to report capacity." 1
fi

# ─── Parse arguments ──────────────────────────────────────────────────────────

OUTPUT_JSON=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 [--help] [--dry-run] [--json]"
      echo ""
      echo "Poll Nomad API and compute free cluster headroom."
      echo ""
      echo "Options:"
      echo "  --help     Show this help message."
      echo "  --dry-run  Log what would be done without side effects."
      echo "  --json     Output results as JSON."
      echo ""
      echo "Environment variables (see scale-common.sh for defaults):"
      echo "  NOMAD_ADDR                        Nomad server HTTP API base URL."
      echo "  NOMAD_AGENT_MEMORY_RESERVATION_MB Memory reservation per agent slot."
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --json)
      OUTPUT_JSON=true
      shift
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      shift
      ;;
  esac
done

# ─── Check Nomad connectivity ─────────────────────────────────────────────────

log "Checking Nomad cluster capacity..."
log "  Nomad API:    ${NOMAD_ADDR}"
log "  Agent memory: ${NOMAD_AGENT_MEMORY_RESERVATION_MB} MB/slot"
log "  Dry run:      ${DRY_RUN:-false}"

# In dry-run mode, skip API calls and report "unknown" rather than zeros.
# Zeros would look like a real "no capacity" reading to callers.
if [[ "${DRY_RUN:-false}" == "true" ]]; then
  log "[DRY-RUN] Skipping Nomad API calls; capacity values are unknown."
  if [[ "${OUTPUT_JSON}" == "true" ]]; then
    echo '{"free_memory_mb": "unknown", "free_slots": "unknown", "total_memory_mb": "unknown", "free_memory_pct": "unknown", "ready_nodes": "unknown", "agent_memory_reservation_mb": '"${NOMAD_AGENT_MEMORY_RESERVATION_MB}"', "dry_run": true}'
  else
    echo "free_memory_mb=unknown"
    echo "free_slots=unknown"
    echo "total_memory_mb=unknown"
    echo "free_memory_pct=unknown"
    echo "ready_nodes=unknown"
    echo "agent_memory_reservation_mb=${NOMAD_AGENT_MEMORY_RESERVATION_MB}"
  fi
  echo "[DRY-RUN] dry_run=true"
  exit 0
fi

# Verify Nomad is reachable
if ! nomad_api GET "/v1/status/leader" > /dev/null 2>&1; then
  die "Nomad API is unreachable at ${NOMAD_ADDR}. Is the Nomad server running?" 1
fi

# ─── Enumerate nodes ──────────────────────────────────────────────────────────

log "Fetching node list from Nomad..."

if ! NODES_JSON="$(nomad_api GET "/v1/nodes")"; then
  die "Failed to fetch node list from Nomad." 1
fi

# An error body such as {"error": "Permission denied"} must not read as an empty cluster.
if ! jq -e 'type == "array"' <<< "${NODES_JSON}" > /dev/null 2>&1; then
  die "Nomad node list is not a JSON array. Refusing to report capacity." 1
fi

# Ready, eligible agent-class candidates. The list stub has no Meta.node_pool, so each
# candidate's full node object is fetched and checked against the pool before it is counted.
if ! CANDIDATE_IDS="$(jq -r '.[] | select(.Status == "ready" and .SchedulingEligibility == "eligible" and .NodeClass == "agent") | .ID' <<< "${NODES_JSON}")"; then
  die "Failed to read candidate nodes from the Nomad node list. Refusing to report capacity." 1
fi

READY_NODE_IDS=()
READY_NODE_JSONS=()
while IFS= read -r candidate_id; do
  [[ -n "${candidate_id}" ]] || continue
  if [[ ! "${candidate_id}" =~ ^[A-Za-z0-9-]+$ ]]; then
    die "Nomad node list contains an unexpected node ID. Refusing to report capacity." 1
  fi
  if ! node_json="$(nomad_api GET "/v1/node/${candidate_id}")"; then
    die "Failed to fetch details for node ${candidate_id}. Refusing to report partial capacity." 1
  fi
  # Only a well-formed node object for this candidate may be skipped as "no". An error body,
  # a different ID or a missing class, Meta or NodeResources is a failure (jq exits non-zero).
  # The list stub can be stale, so Status and SchedulingEligibility are re-checked on the detail.
  if ! node_match="$(jq -r --arg id "${candidate_id}" --arg pool "${NOMAD_AUTOSCALE_NODE_POOL}" '
    if .ID != $id then error("node ID does not match the candidate")
    elif (.NodeClass | type) != "string" then error("NodeClass missing or not a string")
    elif (.Meta | type) != "object" then error("Meta missing or not an object")
    elif (.NodeResources | type) != "object" then error("NodeResources missing or not an object")
    elif (.Status | type) != "string" then error("Status missing or not a string")
    elif (.SchedulingEligibility | type) != "string" then error("SchedulingEligibility missing or not a string")
    elif ((.Meta.node_pool | type) as $pt | $pt != "string" and $pt != "null") then error("Meta.node_pool is not a string")
    elif .NodeClass == "agent" and .Meta.node_pool == $pool and .Status == "ready" and .SchedulingEligibility == "eligible" then "yes"
    else "no" end' <<< "${node_json}")"; then
    die "Node ${candidate_id}: details are not a node object for this candidate. Refusing to report capacity." 1
  fi
  if [[ "${node_match}" == "yes" ]]; then
    READY_NODE_IDS+=("${candidate_id}")
    READY_NODE_JSONS+=("${node_json}")
  fi
done <<< "${CANDIDATE_IDS}"

READY_COUNT="${#READY_NODE_IDS[@]}"
log "  Ready nodes: ${READY_COUNT}"

if [[ "${READY_COUNT}" -eq 0 ]]; then
  log "WARNING: No ready Nomad client nodes found. Cluster has no capacity for agent placement."
  if [[ "${OUTPUT_JSON}" == "true" ]]; then
    echo '{"free_memory_mb": 0, "free_slots": 0, "total_memory_mb": 0, "free_memory_pct": 0, "ready_nodes": 0, "agent_memory_reservation_mb": '"${NOMAD_AGENT_MEMORY_RESERVATION_MB}"'}'
  else
    echo "free_memory_mb=0"
    echo "free_slots=0"
    echo "total_memory_mb=0"
    echo "free_memory_pct=0"
    echo "ready_nodes=0"
    echo "agent_memory_reservation_mb=${NOMAD_AGENT_MEMORY_RESERVATION_MB}"
  fi
  exit 2
fi

# ─── Compute per-node resources ───────────────────────────────────────────────

TOTAL_MEMORY_MB=0
TOTAL_FREE_MEMORY_MB=0
FREE_SLOTS=0

for ((idx = 0; idx < READY_COUNT; idx++)); do
  node_id="${READY_NODE_IDS[idx]}"
  node_json="${READY_NODE_JSONS[idx]}"
  # Allocations of a node whose details were fetched above. Any failure stops the snapshot:
  # a skipped node would silently under-report free capacity.
  if ! allocs_json="$(nomad_api GET "/v1/node/${node_id}/allocations")"; then
    die "Failed to fetch allocations for node ${node_id}. Refusing to report partial capacity." 1
  fi

  # Per-node fit: memory and CPU, with pending and running allocations occupying the node.
  # Memory and CPU are not taken from the cluster total; a missing figure fails the snapshot.
  if ! fit_json="$(printf '{"node":%s,"allocations":%s}' "${node_json}" "${allocs_json}" | capacity_node_fit)"; then
    die "Node ${node_id}: cannot compute memory/CPU fit (missing figure or unrecognised allocation status). Refusing to report capacity." 1
  fi
  IFS=$'\t' read -r node_mem_mb reserved_mem_mb allocated_mem_mb free_mem_mb node_cpu_mhz allocated_cpu_mhz free_cpu_mhz <<< "$(jq -r \
    '[.total_memory_mb, .reserved_memory_mb, .allocated_memory_mb, .free_memory_mb, .total_cpu_mhz, .allocated_cpu_mhz, .free_cpu_mhz] | @tsv' <<< "${fit_json}")"

  # Integer slots per node, summed. Free fragments across nodes are never pooled into slots.
  if ! node_slots="$(capacity_node_slots "${free_mem_mb}" "${free_cpu_mhz}" "${NOMAD_AGENT_MEMORY_RESERVATION_MB}" "${NOMAD_AGENT_CPU_RESERVATION_MHZ}")"; then
    die "Node ${node_id}: slot computation failed. Refusing to report capacity." 1
  fi
  FREE_SLOTS=$(( FREE_SLOTS + node_slots ))

  TOTAL_MEMORY_MB=$(( TOTAL_MEMORY_MB + node_mem_mb ))
  TOTAL_FREE_MEMORY_MB=$(( TOTAL_FREE_MEMORY_MB + free_mem_mb ))

  log "  Node ${node_id}: mem total=${node_mem_mb}MB reserved=${reserved_mem_mb}MB allocated=${allocated_mem_mb}MB free=${free_mem_mb}MB; cpu total=${node_cpu_mhz} allocated=${allocated_cpu_mhz} free=${free_cpu_mhz}; slots=${node_slots}"
done

FREE_MEMORY_PCT=0
if [[ "${TOTAL_MEMORY_MB}" -gt 0 ]]; then
  FREE_MEMORY_PCT=$(( TOTAL_FREE_MEMORY_MB * 100 / TOTAL_MEMORY_MB ))
fi

log "──────────────────────────────────────────"
log "  Total cluster memory:  ${TOTAL_MEMORY_MB} MB"
log "  Free allocatable:      ${TOTAL_FREE_MEMORY_MB} MB (${FREE_MEMORY_PCT}%)"
log "  Free agent slots:      ${FREE_SLOTS}"
log "  Ready nodes:           ${READY_COUNT}"
log "──────────────────────────────────────────"

# ─── Output ───────────────────────────────────────────────────────────────────

if [[ "${OUTPUT_JSON}" == "true" ]]; then
  cat <<EOF
{"free_memory_mb": ${TOTAL_FREE_MEMORY_MB}, "free_slots": ${FREE_SLOTS}, "total_memory_mb": ${TOTAL_MEMORY_MB}, "free_memory_pct": ${FREE_MEMORY_PCT}, "ready_nodes": ${READY_COUNT}, "agent_memory_reservation_mb": ${NOMAD_AGENT_MEMORY_RESERVATION_MB}}
EOF
else
  echo "free_memory_mb=${TOTAL_FREE_MEMORY_MB}"
  echo "free_slots=${FREE_SLOTS}"
  echo "total_memory_mb=${TOTAL_MEMORY_MB}"
  echo "free_memory_pct=${FREE_MEMORY_PCT}"
  echo "ready_nodes=${READY_COUNT}"
  echo "agent_memory_reservation_mb=${NOMAD_AGENT_MEMORY_RESERVATION_MB}"
fi

exit 0
