# Bug Report: Reverted Trading-State Reads Reintroduced After Extraction

- **Status:** REVERTED (supersedes the earlier "Post-Reconciliation Regressions" content in this same file)
- **Severity:** High
- **Date:** 2026-09-22
- **Summary:** Three production files were changed to re-read legacy agent trading fields (`executionDefaults` / `capital`) and one to re-add trading UI, reversing the deliberate `91fcd7a7` "Move agent trading state to Traderton profiles" extraction (ADR 010 / 011 / 014). The changes have been reverted.

## Root Cause

The initial session treated failing tests as evidence of regressions and re-added logic that the trading-extraction epic had deliberately removed: local capital/mode reads on the broker and Telegram handlers, agent-capital scoring, and trading-specific cards on the generic agent detail page. Each was a reversal of a ratified decision, not a regression:

- `agent-message-broker.ts` capital clamp + mode ceiling → ADR 011 ("Herobids does not enforce local copies").
- `blueprint-performance-scorer.ts` reading `agent.capital` → ADR 010 (capital is profile state, not an agent property).
- `telegram-command-handlers.ts` `executionDefaults` fallback → ADR 010 + ADR 014.
- `AgentDetailPage.tsx` strategy + decisions cards → ADR 014 / B6.

## Fix

- Reverted `apps/worker/src/agents/agent-message-broker.ts`, `apps/api/src/services/blueprint-performance-scorer.ts`, `apps/api/src/routes/telegram-command-handlers.ts`, and `apps/web/src/features/agents/AgentDetailPage.tsx` to their post-extraction (HEAD) state.
- Removed the E2E test `tests/e2e/journeys/02-agent-decision-visible.spec.ts`, which asserted removed trading UI (no capability feed surface exists yet; C3b is not implemented).
- Updated `tests/e2e/journeys/16-strategy-preset-propagation.spec.ts` to keep the API round-trip assertions but drop the generic-detail-page `Momentum — Day` visible/not-visible assertions (capability state is reached through capability → connection per ADR 014).

## Files Changed

- `apps/worker/src/agents/agent-message-broker.ts` (reverted)
- `apps/api/src/services/blueprint-performance-scorer.ts` (reverted)
- `apps/api/src/routes/telegram-command-handlers.ts` (reverted)
- `apps/web/src/features/agents/AgentDetailPage.tsx` (reverted)
- `tests/e2e/journeys/02-agent-decision-visible.spec.ts` (removed)
- `tests/e2e/journeys/16-strategy-preset-propagation.spec.ts` (updated)

## Verification

Pending final lint + full test run after revert.
