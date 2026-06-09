# Bug Report: Crashed Instances Block Start of Same-Account Instances via Unique Constraint

- **Status:** CLOSED
- **Severity:** Medium
- **Date:** 2026-05-31
- **Discovered:** Stage C runner Step 6 — `POST /instances/:id/start` returned 500
- **Summary:** The partial unique index `uq_trading_instances_active_venue_account` prevents two non-stopped instances from sharing the same `venue_account_id`. Instances in `crashed` status count as "active" under this constraint, so starting a stopped instance fails with a unique violation if a crashed instance already occupies that venue account slot.

## Symptoms

API returns 500 on `POST /instances/:id/start`:

```json
{
  "statusCode": 500,
  "error": "Internal Server Error",
  "message": "Failed query: update \"trading_instances\" set \"status\" = $1, \"updated_at\" = $2, \"started_at\" = $3 where ..."
}
```

The underlying Postgres error is a unique constraint violation on `uq_trading_instances_active_venue_account`.

## Root Cause

The constraint definition:

```sql
CREATE UNIQUE INDEX uq_trading_instances_active_venue_account
  ON trading_instances (venue_account_id)
  WHERE status <> 'stopped';
```

This means any instance with status `crashed`, `running`, or any other non-stopped value occupies the venue account slot. If an instance crashes and is never cleaned up, no other instance with the same venue account can be started.

The scenario:
1. Instance A (shadow) crashes → status = `crashed`, venue_account_id = `va-123`
2. Instance B (shadow, same venue account) is `stopped`
3. Operator tries to start Instance B → sets status to `running` → violates unique constraint because A still holds it

## Fix Applied

The `POST /instances/:id/start` route now handles this at the API layer:

1. **Blocker detection** — before updating status, queries for any non-stopped instance on the same venue account.
2. **Crashed auto-clear** — if the blocker is `crashed`, transitions it to `stopped` (it's inert) and enqueues a stop job.
3. **Running conflict** — if the blocker is legitimately `running`, returns a clear `409 venue_account_conflict` with the blocking instance ID.
4. **Race condition safety** — the update uses a conditional WHERE (`status <> 'running'`) with `.returning()` to reject duplicate starts atomically, and catches PostgreSQL `23505` on the partial unique index as a final backstop.

The runner script workaround (pre-stopping crashed instances) has been removed since the API handles it natively.

## Impact

- Previously blocked any instance start when a crashed instance existed on the same venue account
- Common in development: instances crash frequently during testing, accumulate in `crashed` state
- The 500 error gave no indication of which other instance was blocking
- Now resolved with informative 409 responses

## Regression Tests

Added to `packages/db/src/schema/bots.test.ts`:

> **`bots schema — removed unique index (bug 2026-05-31-003 regression)`**

Three cases:
- **does not import uniqueIndex from drizzle-orm/pg-core** — verifies the schema source does not contain `uniqueIndex` (which would re-introduce a unique constraint).
- **documents the removal with REMOVED marker** — verifies the source retains the `// uq_trading_instances_active_venue_account REMOVED` comment, making any re-introduction deliberate.
- **only uses non-unique index() on venueAccountId** — asserts the regular (non-unique) `idx_bots_venue_account_id` index is present instead.
