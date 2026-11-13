#!/usr/bin/env bash
# cleanup.sh — remove every load-test artefact (Hetzner scale-path plan, task 5.1).
# STAGING ONLY. Stops and purges all `loadtest-` Nomad jobs, runs `nomad system gc`,
# and (optionally) deletes the synthetic `loadtest-` database rows — and nothing else.
#
# SAFETY:
#   - Only jobs whose ID starts with `loadtest-` are purged. Real `agent-` jobs are
#     never touched. The script refuses to purge a job without the prefix.
#   - DB cleanup deletes only rows whose agent/session identifiers start with
#     `loadtest-`. It is opt-in via --database-url and prints counts before deleting.
#
# Run ON the staging control plane (local Nomad API + psql), or set NOMAD_ADDR/NOMAD_TOKEN.
#
# Usage:
#   cleanup.sh [--namespace NS] [--database-url URL] [--dry-run]
#
# Options:
#   --namespace NS     Nomad namespace to scan (default herobids-agents).
#   --database-url URL When set, delete synthetic loadtest- rows via psql.
#   --dry-run          Show what would be removed; make no changes.
#   --help             Show this help.
#
# Env: NOMAD_ADDR (default http://127.0.0.1:4646), NOMAD_TOKEN (or /etc/nomad.d/acl-token).

set -euo pipefail

NAMESPACE="herobids-agents"
DATABASE_URL="${DATABASE_URL:-}"
DRY_RUN=false
NOMAD_ADDR="${NOMAD_ADDR:-http://127.0.0.1:4646}"
NOMAD_TOKEN="${NOMAD_TOKEN:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:-}"; shift 2 ;;
    --database-url) DATABASE_URL="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [[ -z "${NOMAD_TOKEN}" && -r /etc/nomad.d/acl-token ]]; then
  NOMAD_TOKEN="$(cat /etc/nomad.d/acl-token)"
fi

nomad_api() {
  local method="$1" path="$2"
  curl -sS --fail --connect-timeout 10 --max-time 30 \
    -H "X-Nomad-Token: ${NOMAD_TOKEN}" -X "${method}" "${NOMAD_ADDR}${path}"
}

# ── 1. Purge loadtest- jobs ──────────────────────────────────────────────────
echo "Scanning namespace ${NAMESPACE} for loadtest- jobs..."
jobs_json="$(nomad_api GET "/v1/jobs?namespace=${NAMESPACE}")" || die "could not list jobs"
mapfile -t loadtest_jobs < <(jq -r '.[] | select(.ID | startswith("loadtest-")) | .ID' <<< "${jobs_json}")

echo "Found ${#loadtest_jobs[@]} loadtest- job(s)."
for job_id in "${loadtest_jobs[@]}"; do
  # Belt and braces: never act on a job without the prefix.
  [[ "${job_id}" == loadtest-* ]] || { echo "SKIP (no loadtest- prefix): ${job_id}" >&2; continue; }
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] would purge ${job_id}"
  else
    if nomad_api DELETE "/v1/job/${job_id}?namespace=${NAMESPACE}&purge=true" >/dev/null; then
      echo "purged ${job_id}"
    else
      echo "WARNING: failed to purge ${job_id}" >&2
    fi
  fi
done

# ── 2. Garbage-collect Nomad ─────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[DRY-RUN] would run nomad system gc"
else
  nomad_api PUT "/v1/system/gc" >/dev/null && echo "ran nomad system gc" || echo "WARNING: system gc failed" >&2
fi

# ── 3. Delete synthetic DB rows (opt-in) ─────────────────────────────────────
if [[ -n "${DATABASE_URL}" ]]; then
  command -v psql >/dev/null 2>&1 || die "psql not found; cannot clean synthetic rows"
  echo "Synthetic row counts before cleanup:"
  psql "${DATABASE_URL}" -tA -c \
    "SELECT 'agents', count(*) FROM agents WHERE id::text LIKE 'loadtest-%'
     UNION ALL
     SELECT 'agent_runtime_sessions', count(*) FROM agent_runtime_sessions WHERE agent_id::text LIKE 'loadtest-%';" \
    || echo "WARNING: could not read synthetic row counts" >&2
  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] would delete loadtest- rows from agent_runtime_sessions and agents"
  else
    # Sessions first (FK to agents), then agents. Only loadtest- identifiers.
    psql "${DATABASE_URL}" -c \
      "DELETE FROM agent_runtime_sessions WHERE agent_id::text LIKE 'loadtest-%';
       DELETE FROM agents WHERE id::text LIKE 'loadtest-%';" \
      && echo "deleted synthetic loadtest- rows" || echo "WARNING: row cleanup failed" >&2
  fi
else
  echo "No --database-url given; skipping synthetic DB row cleanup."
fi

echo "Cleanup complete."
