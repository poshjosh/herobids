# Bug Report: maxPositionSize Hardcoded to 1 Billion Instead of Agent Capital

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** `AgentIntakeResolver` set `maxPositionSize: quantity('1000000000')` unconditionally, bypassing the agent's configured capital limit.

## Root Cause

In `apps/worker/src/agents/agent-intake-resolver.ts`, the risk limits block used a permissive hardcoded value of 1,000,000,000 for `maxPositionSize` instead of deriving it from the agent's `capital` field. This meant an agent with a small configured capital could still place arbitrarily large orders unconstrained by the `maxPositionSize` limit.

The corresponding unit test (`agent-intake-resolver.test.ts`) correctly expected `maxPositionSize` to equal the agent's capital (`'250'`), so the test was failing with the hardcoded value.

## Fix

Changed:
```ts
maxPositionSize: quantity('1000000000'),
```
to:
```ts
maxPositionSize: quantity(capitalStr),
```
where `capitalStr = agent?.capital ?? '100'`.

## Files Changed

- `apps/worker/src/agents/agent-intake-resolver.ts`

## Verification

Unit test `agent-intake-resolver.test.ts` now passes; `pnpm vitest run` shows 2288 passed.
