# DB MIGRATION AND JOURNAL VERIFICATION

Use an isolated Compose project so this verification does not touch your normal local data. The goal for row 5 is simple: prove that a fresh database can migrate cleanly from zero, the migration journal is aligned with the repo state, and the worker can start successfully against that freshly migrated schema.

**Minimal checklist**

1. Start a disposable Postgres and Redis stack with a fresh Compose project name.
2. Run the `migrate` service against that empty database and confirm it exits successfully.
3. Verify the repo journal file and migration SQL set are aligned.
4. Re-run the migration step and confirm it is a clean no-op or at least exits `0` without trying to apply broken state.
5. Start the worker against the same freshly migrated database and confirm it stays up.
6. Spot-check that the assessment tables expected by this feature exist.
7. Save the command outputs as the verification evidence for row 5.

**Preconditions**

1. Docker and Compose are working locally.
2. `pnpm install` has already been run.
3. Your existing .env is valid enough for the worker to boot in your normal local setup.
4. If `015` is still changing schema or startup-relevant wiring, rerun this procedure after those changes land.

**Command sequence**

```bash
export ROW5_PROJECT=herobids-row5
```

```bash
docker compose -p "$ROW5_PROJECT" down -v --remove-orphans
```

```bash
docker compose -p "$ROW5_PROJECT" up -d postgres redis
```

```bash
docker compose -p "$ROW5_PROJECT" ps
```

```bash
docker compose -p "$ROW5_PROJECT" run --rm migrate
```

```bash
jq -r '.entries | length' packages/db/drizzle/meta/_journal.json
jq -r '.entries[-1].tag' packages/db/drizzle/meta/_journal.json
find packages/db/drizzle -maxdepth 1 -name '*.sql' | sed 's#.*/##' | sort | tail -1
```

```bash
docker compose -p "$ROW5_PROJECT" run --rm migrate
```

```bash
docker compose -p "$ROW5_PROJECT" up -d --build worker
```

```bash
docker compose -p "$ROW5_PROJECT" ps
```

```bash
docker compose -p "$ROW5_PROJECT" logs migrate --tail=200
```

```bash
docker compose -p "$ROW5_PROJECT" logs worker --tail=200
```

```bash
docker compose -p "$ROW5_PROJECT" exec postgres psql -U herobids -d herobids -c "
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
"
```

```bash
docker compose -p "$ROW5_PROJECT" exec postgres psql -U herobids -d herobids -c "\dt"
```

```bash
docker compose -p "$ROW5_PROJECT" down -v
```

**Pass criteria**

Row 5 can be treated as verified if all of these are true:

1. The first `migrate` run exits successfully on the empty database.
2. The journal file in _journal.json is internally sane:
   the entry count is nonzero and the latest journal tag matches the latest migration file naming sequence in drizzle.
3. The second `migrate` run exits successfully and does not reveal broken drift.
4. The worker starts and remains running against that freshly migrated database.
5. The expected assessment and preset-transition tables exist in Postgres.
6. No startup error in worker logs indicates missing columns, missing tables, journal mismatch, or migration drift.

**Fail conditions**

Treat row 5 as still unverified if any of these happen:

1. `migrate` fails on the fresh database.
2. The second `migrate` run tries to repair drift unexpectedly or fails.
3. Worker logs show schema errors such as missing columns or missing relations.
4. The expected assessment tables are absent after migration.
5. The worker exits immediately for a schema-related reason.

**What this verifies and what it does not**

This procedure verifies the core claim behind row 5 in 014-corrected-gap-table.md: fresh-schema migration plus startup compatibility. It does not verify the full end-to-end feature. That broader proof still belongs to Workstream 3 in 016-durable-execution-transition-reconciliation-and-release-evidence.md, especially the `006` acceptance scenario.