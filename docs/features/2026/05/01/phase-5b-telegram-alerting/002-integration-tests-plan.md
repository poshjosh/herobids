# Phase 5b: Integration Tests — Telegram Alerting

## Why this is needed

All existing alerting tests mock the DB and HTTP layers entirely. The three
correctness fixes landed during code review (double-burn, cursor stability,
transactional corpus import) are not exercised by any test that touches real
state. The integration tests here close that gap.

## Scope

Two new test files against a real Postgres database. The Telegram HTTP call
remains mocked (`vi.stubGlobal('fetch', ...)`) — testing the real Bot API is
out of scope.

---

## Shared infrastructure

**New file: `packages/db/src/test-helpers/integration-db.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../schema/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsFolder = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../drizzle',
);

export function createTestDb() {
  const url = process.env['DATABASE_URL']!;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  return { db, client };
}

export async function runMigrations(db: ReturnType<typeof createTestDb>['db']) {
  await migrate(db, { migrationsFolder });
}

/** TRUNCATE a list of tables. Safe for test databases only. */
export async function truncate(
  client: ReturnType<typeof postgres>,
  ...tables: string[]
) {
  await client.unsafe(`TRUNCATE ${tables.join(', ')} CASCADE`);
}
```

This file is only imported by `*.integration.test.ts` files.

---

## Test 1 — `packages/db/src/journal-pg.integration.test.ts`

**Purpose:** Verify `scanAfter` is stable when `appendBatch` gives multiple
rows the same `created_at` (they all share the DB transaction timestamp).

**Skip condition:** `!process.env['DATABASE_URL']`

**Setup / teardown:**
- `beforeAll`: `runMigrations`
- `beforeEach`: `TRUNCATE journal_events CASCADE`
- `afterAll`: close `client`

**Tests (in order):**

1. `append then scanAfter without cursor returns the event`
   - Insert 1 event via `journal.append`
   - `scanAfter({ limit: 10 })` → returns that event; confirms basic read path

2. `appendBatch then scanAfter returns all events in the batch`
   - Insert 3 events via `journal.appendBatch`; they will share the same
     database-assigned `created_at`
   - `scanAfter({ limit: 10 })` → all 3 returned
   - Risk mitigated: with the old `(createdAt, id)` cursor, some rows would be
     skipped on re-scan

3. `cursor advancement skips already-processed events`
   - Append batch A (events 1–3) → call `scanAfter`, capture cursor
     `{ createdAt: last.createdAt, seenIds: [id1, id2, id3] }`
   - Append batch B (events 4–5) via second `appendBatch`
   - `scanAfter({ cursor, limit: 10 })` → returns only events 4–5

4. `same-timestamp cursor does not re-return seen IDs`
   - Append a single-event batch; build cursor from it (`seenIds: [id]`)
   - Append a second event with the same explicit `eventAt` (insert directly
     into the table with the same `created_at` value)
   - `scanAfter({ cursor, limit: 10 })` → returns only the second event
   - This is the core regression test for the seenIds fix

5. `limit is respected and cursor reflects last seen row`
   - Append 5 events; `scanAfter({ limit: 2 })` → 2 rows returned
   - Build cursor, call `scanAfter({ cursor, limit: 2 })` → next 2 rows
   - Final cursor call → remaining 1 row

**Assertions focus:** row count, IDs present, IDs absent (the previously-lost
rows).

---

## Test 2 — `packages/db/src/alert-delivery-repository.integration.test.ts`

**Purpose:** Verify the repository's transactional claim semantics and the
double-burn fix (`claimedAt = new Date()` after a failed attempt, not `null`).

**Skip condition:** `!process.env['DATABASE_URL']`

**Setup / teardown:**
- `beforeAll`: `runMigrations`; also seed a `journal_events` row (the FK
  requires it — insert one row and use its ID throughout)
- `beforeEach`: `TRUNCATE alert_deliveries CASCADE`
- `afterAll`: close `client`

**Tests (in order):**

1. `insert returns an ID for a new delivery`
   - `repo.insert({ journalEventId, channel: 'telegram', destination: '123' })`
   - Returns a non-null string ID

2. `insert returns null for a duplicate event+channel+dest`
   - Call `insert` twice with identical arguments
   - Second call returns `null` (ON CONFLICT DO NOTHING)

3. `getPending claims the row and returns it`
   - Insert a delivery; `getPending({ maxRetries: 3, limit: 10 })`
   - Returns the row; row's `claimedAt` is now set in the DB

4. `getPending does not return a freshly-failed row before the stale window`
   - Insert a delivery; call `getPending` to claim it
   - Call `markAttemptFailed(id, 'timeout', 3)` (newStatus=pending)
   - Immediately call `getPending` again → row NOT returned (claimedAt is now,
     not null; the 60s stale window has not elapsed)
   - This is the core regression test for the double-burn fix

5. `markAttemptFailed with maxRetries reached sets status to failed`
   - Insert a delivery; claim it; call `markAttemptFailed(id, 'err', 1)`
   - DB row has `status='failed'`, `attempts=1`
   - `getPending` → returns nothing (status is failed, not pending)

6. `markDelivered sets status and deliveredAt`
   - Insert and claim; `markDelivered(id)`
   - `wasEventDelivered(journalEventId)` → `true`

7. `getRecentDeliveredAfter filters by cutoff`
   - Insert and deliver two events at different times
   - `getRecentDeliveredAfter(cutoff)` → returns only the one delivered after
     the cutoff

---

## Running

```bash
# Requires local postgres (docker compose up -d)
DATABASE_URL=postgres://herobids:herobids@localhost:5432/herobids pnpm test
```

Only the `*.integration.test.ts` files run; all other tests are unaffected.
`describe.skipIf` ensures CI (no `DATABASE_URL`) skips them silently.

---

## Risk and open questions

- **FK on `alert_deliveries.journal_event_id`**: The schema does not enforce a
  FK to `journal_events` (checked in schema definition), so test 2 can use a
  synthetic UUID without seeding `journal_events`. Verify during implementation.
- **Clock drift in test 4**: The double-burn test depends on `claimedAt` being
  set to `now()` and the stale threshold being `now() - 60s`. In practice the
  assertion is `getPending` returns nothing, which is true as long as the test
  runs in under 60s — safe in any CI environment.
- **Transaction isolation**: `getPending` uses `FOR UPDATE SKIP LOCKED` inside
  a transaction. In tests with a single connection (`max: 1`), the transaction
  will complete before the second `getPending` call, so no deadlock risk.
