# 011 — Plan Quota TOCTOU Fix

## Status
`todo`

## Goal
Prevent a user from exceeding their plan's `maxTradingInstances` limit under concurrent requests. The current `checkBotLimit → insert` in `POST /bots` is non-atomic.

## Problem

```
Request A: checkBotLimit() → 4/5, ok
Request B: checkBotLimit() → 4/5, ok
Request A: INSERT bot → 5/5
Request B: INSERT bot → 6/5  ← over limit, not caught
```

## Scope

- `apps/api/src/routes/bots.ts` — `POST /bots` handler
- `apps/api/src/plan-guards.ts` — `checkBotLimit`

## Approach

Replace the check + insert pattern with a single atomic statement:

```sql
INSERT INTO bots (...)
SELECT ...
WHERE (SELECT count(*) FROM bots WHERE user_id = $userId AND status != 'deleted') < $limit
```

If the `WHERE` condition is false, zero rows are inserted and the handler returns 403.

Alternative: database-level advisory lock scoped to `(userId, 'bot_limit')` wrapping the check + insert. This is simpler but holds a lock for the duration of the insert.

## Acceptance criteria

- [ ] Concurrent `POST /bots` requests from the same user cannot exceed `maxTradingInstances`
- [ ] Integration test covering the race condition (two simultaneous creates at the limit)
- [ ] `pnpm lint` passes
