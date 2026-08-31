#!/usr/bin/env bash
# agent-node-health.sh — Publish agent-node health snapshot to Redis.
# NOTE: This script is also embedded inline in cloud-init-nomad-client.yaml
# (with $$ escaping for Terraform templatefile).
#
# Collects system metrics (memory, disk, CPU, load, uptime) and Nomad metadata,
# then writes a JSON ServerHealthSnapshot to Redis with a 60-second TTL.
# Designed to run as a oneshot systemd service invoked by a 15-second timer.
#
# Usage:
#   agent-node-health.sh [--help]
#
# Exit codes:
#   0  Success — snapshot published to Redis.
#   1  Error — Redis write failed or REDIS_URL not set.
#   2  Disabled — AGENT_NODE_HEALTH_ENABLED is not "true".
#
# Environment:
#   REDIS_URL                   Redis connection URL (required, e.g. redis://10.0.0.1:6379).
#   AGENT_NODE_HEALTH_ENABLED   Feature flag (default: "true"). Set to anything other
#                               than "true" to disable publishing.
#
# Dependencies: bash, redis-cli (redis-tools), jq, free, df, hostname, date.

set -euo pipefail

# ─── Help ─────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [--help]"
  echo ""
  echo "Publish agent-node health snapshot to Redis."
  echo ""
  echo "Environment variables:"
  echo "  REDIS_URL                   Redis connection URL (required)."
  echo "  AGENT_NODE_HEALTH_ENABLED   Feature flag (default: true)."
  exit 0
fi

# ─── Feature flag ─────────────────────────────────────────────────────────────

ENABLED="${AGENT_NODE_HEALTH_ENABLED:-true}"
if [[ "${ENABLED}" != "true" ]]; then
  exit 2
fi

# ─── Validate required env ────────────────────────────────────────────────────

if [[ -z "${REDIS_URL:-}" ]]; then
  echo "ERROR: REDIS_URL is not set." >&2
  exit 1
fi

# ─── Collect hostname ─────────────────────────────────────────────────────────

HOST="$(hostname 2>/dev/null || echo "unknown")"

# ─── Collect memory ───────────────────────────────────────────────────────────

MEM_TOTAL=0
MEM_USED=0
MEM_FREE=0
MEM_AVAILABLE_MB=0

if FREE_OUTPUT="$(free -b 2>/dev/null)"; then
  # "Mem:" line: total used free shared buff/cache available
  MEM_LINE="$(echo "${FREE_OUTPUT}" | grep '^Mem:')"
  MEM_TOTAL="$(echo "${MEM_LINE}" | awk '{print $2}')"
  MEM_USED="$(echo "${MEM_LINE}" | awk '{print $3}')"
  MEM_FREE="$(echo "${MEM_LINE}" | awk '{print $4}')"
  # Available memory in MB (for metadata)
  MEM_AVAILABLE_BYTES="$(echo "${MEM_LINE}" | awk '{print $7}')"
  if [[ -n "${MEM_AVAILABLE_BYTES}" && "${MEM_AVAILABLE_BYTES}" != "0" ]]; then
    MEM_AVAILABLE_MB=$(( MEM_AVAILABLE_BYTES / 1024 / 1024 ))
  fi
fi

# ─── Collect disk ─────────────────────────────────────────────────────────────

DISK_AVAILABLE=false
DISK_TOTAL=0
DISK_USED=0
DISK_FREE=0

if DF_OUTPUT="$(df -B1 / 2>/dev/null)"; then
  DISK_LINE="$(echo "${DF_OUTPUT}" | tail -1)"
  DISK_TOTAL="$(echo "${DISK_LINE}" | awk '{print $2}')"
  DISK_USED="$(echo "${DISK_LINE}" | awk '{print $3}')"
  DISK_FREE="$(echo "${DISK_LINE}" | awk '{print $4}')"
  DISK_AVAILABLE=true
fi

if [[ "${DISK_AVAILABLE}" == "true" ]]; then
  DISK_JSON="$(jq -n --argjson t "${DISK_TOTAL}" --argjson u "${DISK_USED}" --argjson f "${DISK_FREE}" \
    '{ totalBytes: $t, usedBytes: $u, freeBytes: $f }')"
else
  DISK_JSON="null"
fi

# ─── Collect CPU% via /proc/stat delta ────────────────────────────────────────

CPU_PCT="null"

read_cpu_stats() {
  # Returns: user nice system idle iowait irq softirq steal
  local line
  line="$(head -1 /proc/stat 2>/dev/null || echo "")"
  if [[ -n "${line}" ]]; then
    echo "${line}" | awk '{print $2, $3, $4, $5, $6, $7, $8, $9}'
  fi
}

CPU_BEFORE="$(read_cpu_stats)"
if [[ -n "${CPU_BEFORE}" ]]; then
  sleep 1
  CPU_AFTER="$(read_cpu_stats)"
  if [[ -n "${CPU_AFTER}" ]]; then
    # Compute deltas
    read -r b1 b2 b3 b4 b5 b6 b7 b8 <<< "${CPU_BEFORE}"
    read -r a1 a2 a3 a4 a5 a6 a7 a8 <<< "${CPU_AFTER}"

    IDLE_DELTA=$(( (a4 + a5) - (b4 + b5) ))
    TOTAL_DELTA=$(( (a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8) - (b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8) ))

    if [[ "${TOTAL_DELTA}" -gt 0 ]]; then
      NON_IDLE_DELTA=$(( TOTAL_DELTA - IDLE_DELTA ))
      CPU_PCT=$(( NON_IDLE_DELTA * 100 / TOTAL_DELTA ))
    fi
  fi
fi

# ─── Collect load average ────────────────────────────────────────────────────

LOAD1="0"
LOAD5="0"
LOAD15="0"

if [[ -f /proc/loadavg ]]; then
  read -r LOAD1 LOAD5 LOAD15 _ < /proc/loadavg 2>/dev/null || true
fi

# ─── Collect uptime ──────────────────────────────────────────────────────────

UPTIME_SECONDS=0

if [[ -f /proc/uptime ]]; then
  # First field is uptime in seconds (may have decimal)
  RAW_UPTIME="$(awk '{print $1}' /proc/uptime 2>/dev/null || echo "0")"
  UPTIME_SECONDS="${RAW_UPTIME%%.*}"
fi

# ─── Collect Nomad allocations ────────────────────────────────────────────────
# NOTE: `nomad node status -self` requires a read-capable token on ACL-enabled
# clusters. Without NOMAD_TOKEN set, nomadAllocations will report 0.
# A read-only token can be provisioned in a follow-up.

NOMAD_ALLOCS=0

if command -v nomad >/dev/null 2>&1; then
  NOMAD_ALLOCS="$(nomad node status -self -json 2>/dev/null | jq '.Allocations | length' 2>/dev/null || echo "0")"
  if [[ -z "${NOMAD_ALLOCS}" || "${NOMAD_ALLOCS}" == "null" ]]; then
    NOMAD_ALLOCS=0
  fi
fi

# ─── Build timestamp ─────────────────────────────────────────────────────────

UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Build JSON ──────────────────────────────────────────────────────────────

JSON="$(jq -n \
  --arg serverType "agent-server" \
  --arg serverId "${HOST}" \
  --arg hostname "${HOST}" \
  --argjson memTotal "${MEM_TOTAL}" \
  --argjson memUsed "${MEM_USED}" \
  --argjson memFree "${MEM_FREE}" \
  --argjson disk "${DISK_JSON}" \
  --argjson cpuPct "${CPU_PCT}" \
  --argjson load1 "${LOAD1}" \
  --argjson load5 "${LOAD5}" \
  --argjson load15 "${LOAD15}" \
  --argjson uptimeSeconds "${UPTIME_SECONDS}" \
  --arg version "n/a" \
  --arg updatedAt "${UPDATED_AT}" \
  --argjson nomadAllocs "${NOMAD_ALLOCS}" \
  --argjson availMemMb "${MEM_AVAILABLE_MB}" \
  '{
    serverType: $serverType,
    serverId: $serverId,
    hostname: $hostname,
    memory: { totalBytes: $memTotal, usedBytes: $memUsed, freeBytes: $memFree },
    disk: $disk,
    cpuPct: $cpuPct,
    loadAvg: [$load1, $load5, $load15],
    uptimeSeconds: $uptimeSeconds,
    version: $version,
    updatedAt: $updatedAt,
    metadata: { nomadAllocations: $nomadAllocs, availableMemoryMb: $availMemMb }
  }'
)"

# ─── Write to Redis ──────────────────────────────────────────────────────────

REDIS_KEY="herobids:server-health:agent-server:${HOST}"

if ! redis-cli -u "${REDIS_URL}" SET "${REDIS_KEY}" "${JSON}" EX 60 >/dev/null 2>&1; then
  echo "ERROR: Failed to write health snapshot to Redis." >&2
  exit 1
fi

exit 0
