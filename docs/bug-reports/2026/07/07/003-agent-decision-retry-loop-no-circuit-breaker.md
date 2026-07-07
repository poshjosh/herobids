# Agent decision retry loop — no circuit breaker for no_context / swap.instrument_format

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** Agent decision failures with `no_context` and `swap.instrument_format` codes are marked `retryable: true` indefinitely. Agents stuck in retry loops waste LLM tokens — one agent recorded 69 `no_context` failures for WIF/RENDER/LIT across ~2 hours, and another recorded 42 `swap.instrument_format` failures. The bot `TradingActor` already has a circuit breaker for strategy errors (Issue 1 in the agent-runtime-reliability plan); agent-direct decisions lacked equivalent protection.
- **Root Cause:** `AgentDecisionHandler` records failures via `recordFailure()` but has no per-instrument consecutive-failure counter. Both `no_context` (mark price unavailable — will never self-heal) and `swap.instrument_format` (bare symbol submitted to swap venue — could self-heal but agent hasn't reformatted) are marked `retryable: true` regardless of repeat count.
- **Fix:** Added a per-instrument circuit breaker to `AgentDecisionHandler`:
  - `no_context` → hardened after **3** consecutive failures (mark data won't appear)
  - `swap.instrument_format` → hardened after **5** consecutive failures (agent has had enough chances to reformat)
  - Counters reset on first successful decision acceptance for that instrument
  - Stale entries (>5 min) pruned when map exceeds 200 entries
  - Thresholds defined as `CIRCUIT_BREAKER_THRESHOLDS` constant; should move to operator config (`agentRiskDefaults.*`) when the config schema is extended
  - When tripped, the rejection message includes `[CIRCUIT BREAKER: N consecutive 'code' failures on instrument. ...]` and `retryable` is flipped to `false`
- **Files Changed:**
  - `apps/worker/src/agents/agent-decision-handler.ts` — added `failureCounters` map, `checkCircuitBreaker()`, `resetCircuitBreaker()`, and wired into `isIntakeRejection` and `no_context` paths plus acceptance reset
- **Verification:** `pnpm lint` (tsc --noEmit) passes cleanly. Behaviour verified by code review — circuit breaker trips after threshold consecutive failures and resets on success.
- **References:**
  - Plan: `docs/features/2026/07/05/001-agent-runtime-reliability/001-plan.md` (Issue 1 — same pattern for bots)
  - Eval: `.ignore/eval/2026/07/07/6580df07-9d47-4b04-88b9-5e8de3a43749/01/REPORT.md`
