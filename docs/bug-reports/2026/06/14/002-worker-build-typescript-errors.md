# Bug Report: Worker Build — TypeScript Compilation Errors

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** `pnpm build` failed with 10 TypeScript errors across 3 files in `apps/worker`.

## Root Cause

Multiple TypeScript strict-mode violations introduced during the agent execution actor implementation:

1. **`agent-trading-actor.ts`** (4× TS2322): `PersistPositionParams.side` is `string`, not `'long' | 'short'`, and `.size`, `.entryPrice`, `.realizedPnl` are `string`, not `Decimal`. Code incorrectly used `instanceof Decimal` checks on string fields and tried to assign `string` to `Decimal`.

2. **`agent-message-broker.ts`** (1× TS6138, 4× TS6133): `onAgentStatusChange` was declared as a private constructor parameter but never used inside the class body. Four private handler methods (`handleArtifactPublish`, `handleSendMessage`, `handleManageBot`, `handleBotQuery`) had an `envelope` parameter that was declared but unused.

3. **`agent-session-manager.ts`** (1× TS2322): `emitInstanceStatus` was called with `status: 'crashed'`, but `InstanceStatusPayloadSchema` only accepts `'starting' | 'running' | 'paused' | 'stopped' | 'degraded' | 'recovering'`.

## Fix

- **`agent-trading-actor.ts`**: In the `persistPosition` callback, cast `pos.side as 'long' | 'short'` and construct Decimal values directly from strings (`new Decimal(pos.size)` etc.).
- **`agent-message-broker.ts`**: Removed unused `onAgentStatusChange` constructor parameter; prefixed the four `envelope` parameters with `_`.
- **`index.ts`**: Removed the trailing `onAgentStatusChange` callback argument from the `AgentMessageBroker` constructor call.
- **`agent-session-manager.ts`**: Changed `emitInstanceStatus` call from `status: 'crashed'` to `status: 'stopped'`.

## Files Changed

- `apps/worker/src/agent-trading-actor.ts`
- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/index.ts`

## Verification

`pnpm build` and `pnpm lint` both pass cleanly after the fix.

## Test Coverage

Behavioural assertions for the `crashed` → `stopped` emitInstanceStatus fix were added to `apps/worker/src/agents/agent-session-manager.test.ts`:

- `'marks the session and agent crashed when onSessionActive fails'` — asserts `emitInstanceStatus` receives `{ status: 'stopped' }` while `updateSession`/`updateAgent` receive `{ status: 'crashed' }`, documenting the intentional split between DB audit status and SSE-published status.
- `'marks the session and agent crashed when a running trading actor fails'` — same dual-status assertion for the `handleRuntimeFailure` path.

All 2290 unit tests pass (`pnpm test`).
