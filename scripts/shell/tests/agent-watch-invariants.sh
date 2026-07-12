#!/usr/bin/env bash
# agent-watch-invariants.sh — Verify watch integrity invariants against Redis
#
# Two invariants are checked for every target agent:
#   1. No protective watch (stop_loss / take_profit / exit) exists without
#      either canonical instrument identity OR a worker-derived positionKey.
#   2. No structured watch (schemaVersion >= 2) exists without a purpose field.
#
# Usage:
#   # Audit a single agent
#   scripts/shell/tests/agent-watch-invariants.sh --agent-id <uuid>
#
#   # Audit all active agents
#   scripts/shell/tests/agent-watch-invariants.sh --all-agents
#
#   # Override Redis host/port
#   REDIS_HOST=10.0.0.5 scripts/shell/tests/agent-watch-invariants.sh --agent-id <uuid>
#
# Exit codes:
#   0 — all invariants hold (or no watches to check)
#   1 — one or more invariant violations found
#   2 — usage error (missing agent-id, redis unreachable, etc.)
#
# Requirements: redis-cli, jq
#
# ─────────────────────────────────────────────────────────────────
# Background
# ─────────────────────────────────────────────────────────────────
#
# These invariants were established by the protective-watch contract closure
# feature (docs/features/2026/07/12/004-agent-direct-protection-alignment/).
#
# Invariant 1 (protective linkage):
#   Every watch with purpose=stop_loss|take_profit|exit MUST carry either
#   instrument.instrumentId OR coverage.positionKey. A protective watch
#   without linkage can never count as protective coverage — it's a
#   false-success record that the runtime will silently ignore.
#
# Invariant 2 (structured contract):
#   Every watch with schemaVersion >= 2 MUST carry a purpose field.
#   The parser no longer repairs missing purpose — such records are
#   discarded. A watch without purpose is malformed and invisible to
#   coverage evaluation.
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Helpers ──────────────────────────────────────────────────────────────────

REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
REDIS_CLI="redis-cli -h $REDIS_HOST -p $REDIS_PORT"

log()    { echo "[$(date '+%H:%M:%S')] $*"; }
ok()     { echo "[$(date '+%H:%M:%S')]  ✓ $*"; }
warn()   { echo "[$(date '+%H:%M:%S')]  ⚠ $*" >&2; }
die()    { echo "[$(date '+%H:%M:%S')]  ✗ $*" >&2; exit 2; }
viol()   { echo "[$(date '+%H:%M:%S')]  ✗ VIOLATION: $*" >&2; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
  exit 2
}

# ─── Argument parsing (must come before prerequisite checks so --help works) ──

AGENT_ID=""
ALL_AGENTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-id)
      AGENT_ID="$2"
      shift 2
      ;;
    --all-agents)
      ALL_AGENTS=1
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      die "Unknown argument: $1  (use --help for usage)"
      ;;
  esac
done

if [[ "$ALL_AGENTS" -eq 0 && -z "$AGENT_ID" ]]; then
  die "Either --agent-id <uuid> or --all-agents is required."
fi

# ─── Prerequisite checks ─────────────────────────────────────────────────────

for cmd in redis-cli jq; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is required but not found in PATH."
done

$REDIS_CLI PING &>/dev/null || die "Redis unreachable at $REDIS_HOST:$REDIS_PORT"

# ─── Resolve agent IDs ───────────────────────────────────────────────────────

if [[ "$ALL_AGENTS" -eq 1 ]]; then
  # Collect agent IDs from Redis. Strategy:
  #   1. Active sessions: agent:sessions:active (SET)
  #   2. Any agent with watches: scan agent:watches:* keys
  # Union both sources so we don't miss agents that have watches but are
  # not currently active (e.g. paused, stopped, recently torn down).
  AGENT_IDS=()
  while IFS= read -r id; do
    [[ -n "$id" ]] && AGENT_IDS+=("$id")
  done < <($REDIS_CLI --raw SMEMBERS agent:sessions:active 2>/dev/null)

  while IFS= read -r key; do
    # Keys are agent:watches:<uuid> — extract the UUID
    local_id="${key#agent:watches:}"
    # Skip summary/notified keys
    [[ "$local_id" == summary:* ]] && continue
    [[ "$local_id" == notified:* ]] && continue
    [[ -z "$local_id" ]] && continue
    # Add if not already in the list
    if [[ ! " ${AGENT_IDS[*]:-} " =~ " ${local_id} " ]]; then
      AGENT_IDS+=("$local_id")
    fi
  done < <($REDIS_CLI --raw KEYS 'agent:watches:*' 2>/dev/null | grep -vE ':(summary|notified):')

  if [[ ${#AGENT_IDS[@]} -eq 0 ]]; then
    ok "No agents found with active sessions or watches — nothing to check."
    exit 0
  fi
  log "Auditing ${#AGENT_IDS[@]} agent(s)"
else
  AGENT_IDS=("$AGENT_ID")
fi

# ─── Invariant checks ────────────────────────────────────────────────────────

VIOLATIONS=0
CHECKED_AGENTS=0
CHECKED_WATCHES=0

check_agent() {
  local agent_id="$1"
  local watch_key="agent:watches:${agent_id}"
  local field_count

  field_count=$($REDIS_CLI --raw HLEN "$watch_key" 2>/dev/null || echo 0)
  if [[ "$field_count" -eq 0 ]]; then
    return 0  # no watches — nothing to check
  fi

  CHECKED_AGENTS=$((CHECKED_AGENTS + 1))

  # Read all watch JSON values
  local watches_json
  watches_json=$($REDIS_CLI --raw HGETALL "$watch_key" 2>/dev/null)
  if [[ -z "$watches_json" ]]; then
    return 0
  fi

  # Process each watch: Redis HGETALL returns field, value, field, value...
  # We only care about the values (odd-numbered lines in a 1-indexed split,
  # or every second entry in a 0-indexed split).
  local idx=0
  local watch_id=""
  while IFS= read -r line; do
    if [[ $((idx % 2)) -eq 0 ]]; then
      watch_id="$line"
    else
      local watch_json="$line"
      CHECKED_WATCHES=$((CHECKED_WATCHES + 1))

      # ── Invariant 1: protective watches must have linkage ────────────────
      local purpose
      purpose=$(echo "$watch_json" | jq -r '.purpose // empty' 2>/dev/null)
      if [[ "$purpose" == "stop_loss" || "$purpose" == "take_profit" || "$purpose" == "exit" ]]; then
        local has_instrument
        local has_position_key
        has_instrument=$(echo "$watch_json" | jq -r '.instrument.instrumentId // empty' 2>/dev/null)
        has_position_key=$(echo "$watch_json" | jq -r '.coverage.positionKey // empty' 2>/dev/null)

        if [[ -z "$has_instrument" && -z "$has_position_key" ]]; then
          viol "Agent ${agent_id} watch ${watch_id}: protective purpose=${purpose} but no instrument.instrumentId or coverage.positionKey"
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
      fi

      # ── Invariant 2: structured watches must have purpose ────────────────
      local schema_ver
      schema_ver=$(echo "$watch_json" | jq -r '.schemaVersion // 0' 2>/dev/null)
      if [[ "$schema_ver" -ge 2 ]]; then
        local has_purpose
        has_purpose=$(echo "$watch_json" | jq -r '.purpose // empty' 2>/dev/null)
        if [[ -z "$has_purpose" ]]; then
          viol "Agent ${agent_id} watch ${watch_id}: schemaVersion=${schema_ver} but purpose is missing"
          VIOLATIONS=$((VIOLATIONS + 1))
        fi
      fi
    fi
    idx=$((idx + 1))
  done <<< "$watches_json"

  if [[ $((field_count)) -gt 0 ]]; then
    log "  Agent ${agent_id}: ${field_count} watch(es) checked"
  fi
}

for agent_id in "${AGENT_IDS[@]}"; do
  check_agent "$agent_id"
done

# ─── Report ───────────────────────────────────────────────────────────────────

echo ""
log "=== Watch Invariant Report ==="
log "  Agents checked:  ${CHECKED_AGENTS}"
log "  Watches checked: ${CHECKED_WATCHES}"
log "  Violations:      ${VIOLATIONS}"
echo ""

if [[ "$VIOLATIONS" -gt 0 ]]; then
  warn "${VIOLATIONS} watch invariant violation(s) detected."
  warn "See the protective watch contract closure plan for remediation:"
  warn "  docs/features/2026/07/12/004-agent-direct-protection-alignment/002-protective-watch-contract-closure.md"
  exit 1
fi

if [[ "$CHECKED_WATCHES" -gt 0 ]]; then
  ok "All watch invariants hold (${CHECKED_WATCHES} watch(es) across ${CHECKED_AGENTS} agent(s))."
else
  ok "No watches found — nothing to verify."
fi
