# 003 — Bot Detail Page Shows "Agent not found" for Unknown Bot ID

- **Status:** CLOSED
- **Severity:** Low
- **Date:** 2026-06-09

## Summary

Navigating to `/bots/<non-existent-id>` renders an empty state with the title
`"Agent not found"` and message `"This agent does not exist or you don't have
access."`. The copy uses "agent" terminology instead of "bot", inconsistent with
the rest of the Bots section. Additionally there is no back-navigation action,
leaving the user stranded on a dead-end page.

## Root Cause

`apps/web/src/features/instances/detail/InstanceDetailPage.tsx` — the not-found
branch was copy-pasted from an earlier agent-centric version of the page before
the UI was renamed to "Bots". The `EmptyState` call kept the original agent copy
and no `action` prop was ever added.

```tsx
// Before fix
<EmptyState
  title="Agent not found"
  message="This agent does not exist or you don't have access."
/>
```

## Fix

Updated the `EmptyState` props in the `!inst` early-return branch to use bot
terminology and added a `"← Back to bots"` navigation action:

```tsx
// After fix
<EmptyState
  title="Bot not found"
  message="This bot does not exist or you don't have access."
  action={<Button variant="ghost" size="sm" onClick={() => navigate('/bots')}>← Back to bots</Button>}
/>
```

## Files Changed

- `apps/web/src/features/instances/detail/InstanceDetailPage.tsx`

## Verification

Navigated to `http://localhost:5173/bots/nonexistent-id-abc123` after the fix.
Playwright confirmed `text=Bot not found` is present, `hasBackButton: 1`, and
the back button navigates to `/bots`.

## Regression Tests

`tests/e2e/journeys/10-bot-detail-not-found.spec.ts` — Journey 10 covers two
scenarios:

1. **"shows 'Bot not found' empty state for unknown bot ID"** — navigates to
   `/bots/00000000-0000-0000-0000-000000000000`, asserts the EmptyState title
   `"Bot not found"` and message `"This bot does not exist or you don't have
   access."` are visible. Regression: previously the `isError` branch showed the
   generic `ErrorState` ("Something went wrong / not_found") for 404 responses,
   and the `!inst` EmptyState branch used the wrong "Agent not found" copy and
   lacked back navigation.

2. **"not-found page has a back-navigation action to /bots"** — verifies the
   `"← Back to bots"` button is visible and clicking it navigates the user to
   `/bots`, so they are not stranded on the 404 page.

Both tests pass (2 passed in 8.0s). `pnpm lint` clean.

### Root cause of original fix being incomplete

The original D-02 fix only changed the `!inst` early-return branch which is
**dead code** — `GET /bots/:id` always returns 404 for non-existent IDs, which
React Query surfaces as `isError: true`, never reaching `!inst`. The complete
fix also updates the `isError` branch to detect `err instanceof ApiError &&
err.code === 'not_found'` and renders the EmptyState instead of the generic
ErrorState.
