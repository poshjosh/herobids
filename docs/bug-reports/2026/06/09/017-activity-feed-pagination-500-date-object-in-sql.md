# Bug Report 017 — Activity Feed Pagination Fails with 500: Date Object Passed to SQL

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-09
- **Summary:** Clicking "Load older events" on the Activity Feed page (`/activity`) resulted in a 500 error, breaking cursor-based pagination.

## Root Cause

In `apps/api/src/routes/dashboard.ts`, the `GET /dashboard/activity` handler used `new Date(before)` when constructing the SQL pagination cursor:

```ts
// Bug: postgres-js does not accept Date objects in sql`` template literals
sql`${journalEvents.createdAt} < ${new Date(before)}`
sql`${journalEvents.createdAt} = ${new Date(before)}`
```

The `before` query param is already validated as an ISO datetime string by `DashboardActivityQuerySchema` (`z.string().datetime()`). Wrapping it in `new Date()` converts it to a `Date` object, which postgres-js (the underlying Drizzle ORM driver) rejects with:

```
The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.
Received an instance of Date
```

## Fix

Pass the ISO string directly with an explicit `::timestamptz` cast so PostgreSQL handles the type coercion:

```ts
// Before
sql`${journalEvents.createdAt} < ${new Date(before)}`
sql`${journalEvents.createdAt} = ${new Date(before)}`

// After
sql`${journalEvents.createdAt} < ${before}::timestamptz`
sql`${journalEvents.createdAt} = ${before}::timestamptz`
```

## Files Changed

- `apps/api/src/routes/dashboard.ts` — replaced `new Date(before)` with `before` + `::timestamptz` cast in both pagination SQL conditions

## Verification

- After fix: clicking "Load older events" on `/activity` page loaded the next page of events without error
- 50 initial events loaded; clicking the button loaded 10 more (60 total from 60 seeded test events)
- No 500 errors in API logs after the fix
