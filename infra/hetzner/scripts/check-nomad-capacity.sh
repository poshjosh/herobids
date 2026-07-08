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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scale-common.sh"

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

# In dry-run mode, skip API calls and output zero values.
# This allows testing script syntax and flow without a running Nomad cluster.
if [[ "${DRY_RUN:-false}" == "true" ]]; then
  log "[DRY-RUN] Skipping Nomad API calls."
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
  echo "[DRY-RUN] dry_run=true"
  exit 0
fi

# Verify Nomad is reachable
if ! nomad_api GET "/v1/status/leader" > /dev/null 2>&1; then
  die "Nomad API is unreachable at ${NOMAD_ADDR}. Is the Nomad server running?" 1
fi

# ─── Enumerate nodes ──────────────────────────────────────────────────────────

log "Fetching node list from Nomad..."

NODES_JSON="$(nomad_api GET "/v1/nodes" || die "Failed to fetch node list from Nomad." 1)"

# Filter to ready client nodes (not draining, not ineligible, not down)
# jq: select nodes that are ready and have SchedulingEligibility = eligible
READY_NODE_IDS=()
while IFS= read -r node_id; do
  READY_NODE_IDS+=("${node_id}")
done < <(echo "${NODES_JSON}" | jq -r '.[] | select(.Status == "ready" and .SchedulingEligibility == "eligible") | .ID')

READY_COUNT="${#READY_NODE_IDS[@]}"
log "  Ready nodes: ${READY_COUNT}"

if [[ "${READY_COUNT}" -eq 0 ]]; then
  log "WARNING: No ready Nomad client nodes found. Cluster has no capacity for agent placement."
  if [[ "${OUTPUT_JSON}" == "true" ]]; then
    echo '{"free_memory_mb": 0, "free_slots": 0, "total_memory_mb": 0, "ready_nodes": 0, "agent_memory_reservation_mb": '"${NOMAD_AGENT_MEMORY_RESERVATION_MB}"'}'
  else
    echo "free_memory_mb=0"
    echo "free_slots=0"
    echo "total_memory_mb=0"
    echo "ready_nodes=0"
    echo "agent_memory_reservation_mb=${NOMAD_AGENT_MEMORY_RESERVATION_MB}"
  fi
  exit 2
fi

# ─── Compute per-node resources ───────────────────────────────────────────────

TOTAL_MEMORY_MB=0
TOTAL_FREE_MEMORY_MB=0

for node_id in "${READY_NODE_IDS[@]}"; do
  # Get node details (resources)
  node_json="$(nomad_api GET "/v1/node/${node_id}" || {
    log "WARNING: Failed to fetch details for node ${node_id} — skipping."
    continue
  })"

  # Total memory on the node (Nomad sees this as allocatable)
  node_mem_mb="$(echo "${node_json}" | jq -r '.NodeResources.Memory.MemoryMB // 0')"
  if [[ -z "${node_mem_mb}" || "${node_mem_mb}" == "0" || "${node_mem_mb}" == "null" ]]; then
    log "WARNING: Node ${node_id} has no MemoryMB in NodeResources — skipping."
    continue
  fi

  # Reserved memory (Nomad reserves some for system/overhead)
  reserved_mem_mb="$(echo "${node_json}" | jq -r '.ReservedResources.Memory.MemoryMB // 0')"
  if [[ "${reserved_mem_mb}" == "null" ]]; then
    reserved_mem_mb=0
  fi

  # Fetch allocations on this node and sum their allocated memory
  allocs_json="$(nomad_api GET "/v1/node/${node_id}/allocations" || echo "[]")"
  allocated_mem_mb="$(echo "${allocs_json}" | jq -r '[.[] | select(.ClientStatus == "running") | .Resources.Memory.MemoryMB // 0] | add // 0')"
  if [[ "${allocated_mem_mb}" == "null" ]]; then
    allocated_mem_mb=0
  fi

  # Free memory on this node = total - reserved - allocated
  free_mem_mb=$(( node_mem_mb - reserved_mem_mb - allocated_mem_mb ))
  if [[ ${free_mem_mb} -lt 0 ]]; then
    free_mem_mb=0
  fi

  TOTAL_MEMORY_MB=$(( TOTAL_MEMORY_MB + node_mem_mb ))
  TOTAL_FREE_MEMORY_MB=$(( TOTAL_FREE_MEMORY_MB + free_mem_mb ))

  log "  Node ${node_id}: total=${node_mem_mb}MB reserved=${reserved_mem_mb}MB allocated=${allocated_mem_mb}MB free=${free_mem_mb}MB"
done

# ─── Compute slots ────────────────────────────────────────────────────────────

if [[ "${NOMAD_AGENT_MEMORY_RESERVATION_MB}" -gt 0 ]]; then
  FREE_SLOTS=$(( TOTAL_FREE_MEMORY_MB / NOMAD_AGENT_MEMORY_RESERVATION_MB ))
else
  FREE_SLOTS=0
fi

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
