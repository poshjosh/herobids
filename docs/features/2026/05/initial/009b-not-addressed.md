# Phase 3 Follow-up Disposition

This note triages residual Phase 3 concerns so the repo has one clear record of what still blocks LLM validation sign-off versus what was clarified as non-blocking by design.

## Must Fix Before LLM Validation Is Considered Closed

1. **LLM warm-up frames can still spend tokens and hide provider failures.**
	- `BacktestRuntime` defaults LLM runs to `warmUpFrames: 0`, so this is not a universal/default-path cost leak today.
	- The remaining issue is still real when an operator configures non-zero warm-up or when validation requires matching warm-up settings across strategies.
	- `replay-runner.ts` currently calls `strategy.evaluate(...)` during warm-up and ignores the returned `Result`, which means `LlmStrategy` can make provider calls and persist artifacts on frames that are supposed to be non-trading warm-up.
	- Required follow-up: either reject non-zero warm-up for `strategy.type: llm`, or add a warm-up path that does not perform provider I/O. Any warm-up failure that does execute strategy logic must be surfaced in the run/report outcome rather than silently discarded.
	- Phase 4 impact: does not block mechanical live rollout; does block treating LLM replay validation as complete evidence.

2. **Stored decision-context replay still needs an adapter or schema alignment.**
	- Persisted decision contexts are stored in the nested canonical shape used by the trading cycle (`context.snapshot`, `context.position`, `context.referenceMark`, `context.strategyParams`).
	- `context-replay.ts` currently expects a flatter replay helper shape (`context.symbol`, `context.price`, `context.timestamp`) plus original decision fields alongside it.
	- Required follow-up: add a normalization adapter from persisted decision rows plus `decision_contexts` rows into the replay helper input, or change the replay helper to consume the stored nested shape directly.
	- Phase 4 impact: does not block mechanical live rollout; does block claiming the stored-context LLM regression path is complete.

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
- This note must not be read as approval to promote `strategy.type: llm` into live trading.
- LLM live consideration still requires closing the two must-fix items above plus the replay/shadow evidence already required by the Phase 3 plan.