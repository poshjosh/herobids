# 001 — agent.ts: AGENT_ID undefined passed to loadActiveWatchSummary

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-06-13
- **Summary:** `pnpm build` failed in `apps/worker` because `AGENT_ID` (typed `string | undefined`) was passed directly to `loadActiveWatchSummary`, which requires `string`.

## Root Cause

`AGENT_ID` is declared as:

```ts
const AGENT_ID = process.env['AGENT_ID'];  // string | undefined
```

A guard at line 93 exits if `AGENT_ID` is falsy, so by line 1514 it is guaranteed to be defined. However, TypeScript's strict narrowing does not track the narrowing through the module-level guard, so the type remained `string | undefined`. The call to `loadActiveWatchSummary(AGENT_ID)` therefore produced:

```
error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
  Type 'undefined' is not assignable to type 'string'.
```

## Fix

Added a non-null assertion (`!`) at the call site, consistent with other uses of `AGENT_ID` in the same file (e.g. lines 263–264):

```ts
// Before
recordActiveWatchSummary(runtimeState, await loadActiveWatchSummary(AGENT_ID));

// After
recordActiveWatchSummary(runtimeState, await loadActiveWatchSummary(AGENT_ID!));
```

## Files Changed

- `apps/worker/src/agent.ts` — line 1514

## Verification

`pnpm build`, `pnpm lint`, `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`, and `scripts/shell/tests/run-all-tests.sh --e2e` all passed after the fix (18/18 e2e tests green).
