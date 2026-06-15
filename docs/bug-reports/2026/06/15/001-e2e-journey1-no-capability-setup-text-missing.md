# Bug 2026-06-15-001: E2E Journey 1 — "No capability setup required" text missing after agent creation

## Date
2026-06-15

## Severity
LOW — E2E test expectation mismatch; no product regression. No user-facing breakage.

## Summary
Journey 1 (`01-signup-create-agent.spec.ts`) fails because the Create Agent form defaults to the `'trading'` skill preset, which includes "Bot Management" and "Trading" skills. This causes the agent detail page to show a "Trading Unconfigured" capability section rather than the expected "No capability setup required" text.

## Root Cause
`CreateAgentFlow` in `apps/web/src/features/agents/AgentsPage.tsx` initialises `skillPreset: 'trading'` by default. The test uses `createAgent(page, goal, { preset: 'general' })`, but the `helpers.ts` `createAgent` function ignores the `preset` option — it never switches the form to a non-trading preset. As a result the agent is always created with trading skills, and the capability readiness section shows "Trading Unconfigured" rather than the text the test expects.

## Steps to Reproduce
Run `pnpm exec playwright test journeys/01-signup-create-agent.spec.ts`.

## Expected
"No capability setup required" text visible on the agent detail page after creating a general-purpose (non-trading) agent.

## Actual
"Trading Unconfigured" capability readiness section shown instead.

## Fix Required
Either:
1. Update `tests/e2e/helpers.ts` `createAgent` to switch the form's skill preset dropdown to `'general'` or `'custom'` when `options.preset !== 'trading'`; OR
2. Update the test to create an agent with a non-trading preset by changing the form's skill preset dropdown before submission; OR  
3. Update the test assertion to match the current product behaviour (agent is created with trading skills by default).

## Files
- `tests/e2e/journeys/01-signup-create-agent.spec.ts`
- `tests/e2e/helpers.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
