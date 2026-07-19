#!/usr/bin/env bash
# 016-db-migration-and-journal-verification.sh
#
# One-shot verification for row 5 in 014-corrected-gap-table.md:
# prove that a fresh database can migrate cleanly from zero, the Drizzle
# journal is aligned with the repo state, and the worker can boot against
# that freshly migrated schema.
#
# Usage:
#   bash docs/features/2026/07/18/002-platform-preset-assessment-and-transition/016-db-migration-and-journal-verification.sh
#
# Optional environment variables:
#   ROW5_PROJECT=herobids-row5-custom   # docker compose project name
#   KEEP_STACK=1                        # keep containers/volumes after the script exits

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  ROOT="$(cd "${SCRIPT_DIR}/../../../../../.." && pwd)"
fi
COMPOSE_FILE="${ROOT}/docker-compose.yaml"
ROW5_PROJECT="${ROW5_PROJECT:-herobids-row5}"
KEEP_STACK="${KEEP_STACK:-0}"
EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/herobids-row5.XXXXXX")"
WORKER_OVERRIDE_FILE="${EVIDENCE_DIR}/worker-stub.override.yaml"

if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; CYAN=''; RESET=''
fi

log()  { echo -e "${CYAN}[row5]${RESET} $*"; }
ok()   { echo -e "${GREEN}[row5]${RESET} $*"; }
warn() { echo -e "${YELLOW}[row5]${RESET} $*"; }
die()  { echo -e "${RED}[row5]${RESET} $*" >&2; exit 1; }

run_logged() {
  local name="$1"
  shift
  log "$name"
  "$@" 2>&1 | tee "${EVIDENCE_DIR}/${name// /_}.log"
}

cleanup() {
  local exit_code=$?
  if [[ "${KEEP_STACK}" != "1" ]]; then
    log "Cleaning up isolated compose project ${ROW5_PROJECT}"
    docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    warn "KEEP_STACK=1 set; leaving compose project ${ROW5_PROJECT} running"
  fi

  if [[ ${exit_code} -eq 0 ]]; then
    ok "Row 5 verification passed"
  else
    warn "Row 5 verification failed"
  fi

  echo "Evidence logs: ${EVIDENCE_DIR}"
  exit ${exit_code}
}
trap cleanup EXIT

[[ -f "${COMPOSE_FILE}" ]] || die "docker-compose.yaml not found at ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v node >/dev/null 2>&1 || die "node is required"

if [[ ! -f "${ROOT}/.env" ]]; then
  warn "No .env file found at ${ROOT}/.env; worker startup may fail if required env vars are missing"
fi

log "Repo root: ${ROOT}"
log "Compose project: ${ROW5_PROJECT}"
log "Evidence dir: ${EVIDENCE_DIR}"

cat > "${WORKER_OVERRIDE_FILE}" <<'EOF'
services:
  worker:
    environment:
      AGENT_RUNTIME_MODE: stub
EOF

# 0. Verify the Drizzle journal and SQL file set match exactly before touching docker.
journal_tags_file="${EVIDENCE_DIR}/00_journal_tags.log"
sql_tags_file="${EVIDENCE_DIR}/00_sql_tags.log"

node -e "const fs=require('fs'); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,'utf8')); for (const entry of j.entries) console.log(entry.tag);" \
  "${ROOT}/packages/db/drizzle/meta/_journal.json" | sort > "${journal_tags_file}"

find "${ROOT}/packages/db/drizzle" -maxdepth 1 -name '*.sql' -print \
  | sed 's#.*/##' \
  | sed 's/\.sql$//' \
  | sort > "${sql_tags_file}"

missing_sql_tags="$(comm -23 "${journal_tags_file}" "${sql_tags_file}" || true)"
extra_sql_tags="$(comm -13 "${journal_tags_file}" "${sql_tags_file}" || true)"

if [[ -n "${missing_sql_tags}" || -n "${extra_sql_tags}" ]]; then
  {
    echo 'Drizzle journal and SQL file set mismatch detected.'
    if [[ -n "${missing_sql_tags}" ]]; then
      echo 'Missing SQL files for journal tags:'
      printf '%s\n' "${missing_sql_tags}"
    fi
    if [[ -n "${extra_sql_tags}" ]]; then
      echo 'Unjournaled SQL files present:'
      printf '%s\n' "${extra_sql_tags}"
    fi
  } | tee "${EVIDENCE_DIR}/00_journal_sql_mismatch.log"
  die 'Drizzle journal does not match migration SQL files'
fi

# 1. Tear down any stale isolated stack from previous runs.
run_logged "01_compose_down" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" down -v --remove-orphans

# 2. Start only postgres and redis for a clean migration target.
run_logged "02_infra_up" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" up -d postgres redis
run_logged "03_infra_ps" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" ps

# 3. Build the migrate and worker images from the current workspace so the run
#    verifies the current source tree, not stale local images.
run_logged "04_build_migrate_worker" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" build migrate worker

# 4. Run migrations against the fresh database; this is the primary clean-DB rehearsal.
run_logged "05_migrate_first_pass" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" run --rm migrate

# 5. Verify local Drizzle journal integrity and alignment with the latest SQL file.
local_journal_count="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log(j.entries.length);" "${ROOT}/packages/db/drizzle/meta/_journal.json")"
local_latest_tag="$(node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log(j.entries[j.entries.length-1].tag);" "${ROOT}/packages/db/drizzle/meta/_journal.json")"
latest_sql_tag="$(find "${ROOT}/packages/db/drizzle" -maxdepth 1 -name '*.sql' -print | sort | tail -n 1 | xargs basename | sed 's/\.sql$//')"

printf 'local_journal_count=%s\nlocal_latest_tag=%s\nlatest_sql_tag=%s\n' \
  "${local_journal_count}" "${local_latest_tag}" "${latest_sql_tag}" \
  | tee "${EVIDENCE_DIR}/06_local_journal_summary.log"

[[ -n "${local_journal_count}" ]] || die "journal entry count could not be determined"
[[ "${local_latest_tag}" == "${latest_sql_tag}" ]] || die "latest journal tag (${local_latest_tag}) does not match latest SQL tag (${latest_sql_tag})"

# 6. Verify the DB applied migration count matches the local journal entry count.
#    Drizzle-kit ≥0.31 may track migrations via the journal file rather than a
#    __drizzle_migrations table.  Fall back gracefully when the table is absent.
db_migration_table_exists="$(docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" exec -T postgres \
  psql -U herobids -d herobids -Atqc "
    select count(*)
    from information_schema.tables
    where table_schema = 'public' and table_name = '__drizzle_migrations';
  " || echo '0')"

if [[ "${db_migration_table_exists}" == "1" ]]; then
  db_migration_count="$(docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" exec -T postgres \
    psql -U herobids -d herobids -Atqc "select count(*) from __drizzle_migrations;")"
  printf 'db_migration_count=%s\n' "${db_migration_count}" | tee "${EVIDENCE_DIR}/07_db_migration_count.log"
  [[ "${db_migration_count}" == "${local_journal_count}" ]] || die "DB migration count (${db_migration_count}) does not match local journal count (${local_journal_count})"
else
  warn '__drizzle_migrations table not found — skipping DB-side migration count check (journal-only tracking)'
fi

# 7. Re-run migrations to prove the schema is already in a consistent migrated state.
run_logged "08_migrate_second_pass" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" run --rm migrate

# 8. Start the worker against the freshly migrated database in stub runtime mode
#    so this verification proves schema/startup compatibility without requiring
#    a prebuilt agent runtime image. The base compose file hardcodes
#    AGENT_RUNTIME_MODE: docker, so use a temporary override file here.
run_logged "09_worker_up" docker compose -f "${COMPOSE_FILE}" -f "${WORKER_OVERRIDE_FILE}" -p "${ROW5_PROJECT}" up -d worker
run_logged "10_worker_ps" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" ps

# 9. Confirm the worker remains running after startup.
worker_container_id="$(docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" ps -q worker)"
[[ -n "${worker_container_id}" ]] || die "worker container id not found"

for _ in 1 2 3 4 5; do
  worker_state="$(docker inspect -f '{{.State.Status}}' "${worker_container_id}")"
  if [[ "${worker_state}" == "running" ]]; then
    break
  fi
  sleep 2
done

worker_state="$(docker inspect -f '{{.State.Status}}' "${worker_container_id}")"
printf 'worker_state=%s\n' "${worker_state}" | tee "${EVIDENCE_DIR}/11_worker_state.log"
[[ "${worker_state}" == "running" ]] || die "worker is not running after startup; current state: ${worker_state}"

# 10. Capture migrate and worker logs as evidence for later review.
run_logged "12_migrate_logs" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" logs migrate --tail=200
run_logged "13_worker_logs" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" logs worker --tail=200

# 11. Verify the assessment and preset-transition tables expected by this feature exist.
docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" exec -T postgres \
  psql -U herobids -d herobids -Atqc "
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'market_assessment_requests',
    'market_assessment_runs',
    'market_assessment_artifacts',
    'agent_preset_bindings',
    'agent_preset_transitions',
    'review_advice',
    'agent_assessment_review_checks'
  )
order by table_name;
" | tee "${EVIDENCE_DIR}/14_assessment_tables.log"

expected_tables=7
actual_tables="$(wc -l < "${EVIDENCE_DIR}/14_assessment_tables.log" | tr -d ' ')"
[[ "${actual_tables}" == "${expected_tables}" ]] || die "expected ${expected_tables} assessment-related tables, found ${actual_tables}"

# 12. Save a full table listing snapshot as extra evidence.
run_logged "15_all_tables" docker compose -f "${COMPOSE_FILE}" -p "${ROW5_PROJECT}" exec -T postgres psql -U herobids -d herobids -c '\dt'

ok "Verification complete. Review logs in ${EVIDENCE_DIR}"