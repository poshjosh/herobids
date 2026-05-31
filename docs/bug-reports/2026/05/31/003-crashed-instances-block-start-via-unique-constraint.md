# Bug Report: Crashed Instances Block Start of Same-Account Instances via Unique Constraint

- **Status:** FIXED (workaround in runner script)
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

## Workaround Applied

The runner script now stops all crashed instances before attempting to start a new one:

```bash
CRASHED_IDS=$(echo "$INSTANCES_RESPONSE" | jq -r '[.instances[] | select(.status == "crashed")] | .[].id')
for cid in $CRASHED_IDS; do
  curl -s -X POST "$API_URL/instances/$cid/stop" >/dev/null 2>&1 || true
done
```

## Proper Fix (TODO)

The start route should handle this gracefully:
- Before setting status=running, check if another non-stopped instance holds the same venue_account_id
- If the blocker is `crashed`, auto-transition it to `stopped` (it's not doing anything useful)
- Return a clear 409 error if the blocker is legitimately `running` (another worker has it)

Alternatively, a periodic cleanup job could transition `crashed` instances to `stopped` after a configurable timeout.

## Impact

- Blocks any instance start when a crashed instance exists on the same venue account
- Common in development: instances crash frequently during testing, accumulate in `crashed` state
- The 500 error gives no indication of which other instance is blocking
