# Phase 3 Follow-up Disposition

This note triages residual Phase 3 concerns so the repo has one clear record of what still blocks LLM validation sign-off versus what was clarified as non-blocking by design.

## Must Fix Before LLM Validation Is Considered Closed

Both items below have been resolved as of 2026-05-31.

1. **~~LLM warm-up frames can still spend tokens and hide provider failures.~~** ✅ Fixed
	- Resolution: `replay-runner.ts` now rejects `warmUpFrames > 0` for LLM strategies at invocation time (throws with a clear message). Tests in `backtesting.test.ts` cover both the rejection and the zero-warm-up happy path.
	- Approach chosen: "reject non-zero warm-up for `strategy.type: llm`" (stateless strategies have no lookback buffer to fill).

2. **~~Stored decision-context replay still needs an adapter or schema alignment.~~** ✅ Fixed
	- Resolution: `context-replay.ts` exports `normalizeForReplay()` and `normalizeForReplayBatch()` which bridge the nested canonical DB shape (`snapshot`, `position`, `referenceMark`, `balanceSnapshot`, `strategyParams`) into the flat `StoredDecisionContext` shape consumed by `replayContexts()`. Tests in `validation.test.ts` cover both single-row and batch normalization.

## Clarified Non-blockers

1. **Context replay is stateless-only by design.**
	- The Phase 3 design intent is to use context replay for LLM regression, not to reconstruct stateful mechanical strategies from a single stored context.
	- Stateful strategies such as `MomentumStrategy` require sequential corpus replay, not one-context-at-a-time replay.
	- Treat this as a scope boundary that should be documented clearly, not as a defect in the current replay helper.

2. **Strategy instance reuse across runs is not a current worker/runtime bug.**
	- The worker backtest runtime creates fresh strategy instances per run, and the validation path constructs distinct instances for baseline and candidate runs.
	- The exported `runBacktest()` helper still assumes the caller passes a fresh or resettable strategy object. That is an API contract/hardening concern, not a known runtime defect in the current job path.

## Phase 4 Read-through

- Phase 4 may proceed with the mechanical baseline as the first live candidate.
- With both must-fix items resolved, `strategy.type: llm` may be promoted to live pending the replay/shadow evidence already required by the Phase 3 plan.
- LLM live consideration still requires demonstrating sufficient replay match rates and shadow-mode parity before live capital is allocated.