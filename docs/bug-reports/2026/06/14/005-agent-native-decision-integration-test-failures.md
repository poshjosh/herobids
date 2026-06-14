# Bug Report: Integration Test — Agent-Native Decision Silently Rejected (stale_session + insufficient capital)

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** Three integration tests in `agent-native-decision.integration.test.ts` failed because decisions were silently rejected due to two independent bugs: a mismatched `correlationId` (session ID check) and insufficient agent capital (risk gate).

## Root Cause

**Bug 1 — stale_session rejection:**
`AgentDecisionHandler.handleDecisionSubmit` uses `envelope.correlationId` as the `runtimeSessionId` and checks `agentRepo.isActiveSession(agentId, runtimeSessionId)`. The integration test's `makeEnvelope()` generated a random UUID for `correlationId`, which never matched the seeded `agentRuntimeSession.id`. Result: `isActiveSession` returned `false` and every decision was rejected with `stale_session` before any DB write occurred.

**Bug 2 — risk gate: insufficient capital:**
The integration test seeded the agent without a `capital` field (defaulting to `'100'` USD). `AgentIntakeResolver` derives `equity = price(capitalStr) = 100`, `maxOrderNotional = 100`, and `maxPositionSizePct = 100` (meaning max notional = 100% × equity = 100 USD). The test trade was 0.1 BTC at 50,000 USD = 5,000 USD notional, which exceeded 100 USD and was blocked by the risk gate.

## Fix

- **Bug 1 (correlationId):** Changed `makeEnvelope()` to use `correlationId: sessionId` so the active-session check passes.
- **Bug 2 (capital):** Added `capital: '100000'` to the agent `db.insert(agents).values({...})` call in `beforeEach`, giving the agent enough capital for the 5,000 USD notional test trade.

## Files Changed

- `apps/worker/src/__tests__/integration/agent-native-decision.integration.test.ts`

## Verification

Functional tests tier now shows `PASS` in `scripts/shell/tests/run-all-tests.sh --e2e`. All 3 previously failing tests now pass.

## Test Coverage

Two new regression tests were added to `apps/worker/src/__tests__/integration/agent-native-decision.integration.test.ts`:

- `'rejects decision when correlationId does not match the active session id'` — submits a decision with a random UUID as `correlationId` (not matching `sessionId`). Asserts that neither a decision nor an execution plan is persisted (stale_session rejection fires before any DB write).
- `'risk gate rejects decision when agent capital is insufficient for the order notional'` — reduces agent capital to `$100`, then submits a 0.1 BTC decision at the stub mark price of $50,000 (= $5,000 notional). Asserts the decision is persisted, the execution plan is created but marked `failed`, and no fills are created.

All 2290 unit tests pass (`pnpm test`).
