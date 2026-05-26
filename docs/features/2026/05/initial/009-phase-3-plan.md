# Phase 3: Backtesting + LLM Validation

**Goal:** Run the same decision -> risk -> plan -> execute path against historical and replayed data, compare outcomes to paper/shadow behavior, and require reproducible replay evidence before any LLM strategy is considered for live capital.

**Parent:** [003-design-decisions.md](003-design-decisions.md) Section 15 and Section 20

**Depends on:** [008-phase-2c-plan.md](008-phase-2c-plan.md) exit criteria and the existing Phase 2 worker/runtime, shadow execution, reconciliation, and stream infrastructure

**Scope note:** This plan follows [003-design-decisions.md](003-design-decisions.md) Section 14, Section 15, and Section 20. The manual-user path from Section 10.1 remains deferred. Phase 3 is about replay, backtest persistence, and LLM validation on top of the current bot/worker architecture.

---

## Current Repo Anchors (2026-05-25)

These are the concrete seams the implementation must build on.

- `apps/worker/src/trading-actor.ts`
  - `TradingActor.tick()` still owns the entire scan-cycle path: snapshot fetch -> strategy evaluate -> journal -> plan -> risk -> execute -> fill/order/position persistence.
  - This is the main reuse point for backtesting.
- `apps/worker/src/runtime.ts`
  - BullMQ support is lifecycle-only today: `start | stop | restart`.
  - There is no bounded-job runtime for replay/backtest execution yet.
- `apps/worker/src/index.ts`
  - Strategy construction is hardcoded to `new MomentumStrategy(...)`.
  - `config.strategy.type` and `trading_instances.strategy_id` are not used for runtime dispatch yet.
- `packages/domain/src/ports/strategy.ts`
  - The public strategy port is still `evaluate(snapshot, config)`.
  - `MarketSnapshot.data` is the only existing extensibility point for richer replay context.
- `packages/domain/src/config/schema.ts`
  - `strategy.params` is currently untyped (`z.record(z.unknown())`), so the API does not yet validate strategy-specific params.
- `packages/db/src/schema/decisions.ts`
  - A `decisions` table already exists for audit/replay, but no repository writes to it today.
- `packages/db/src/schema/journal-events.ts`
  - Journal persistence exists, but it only keys naturally to `trading_instance_id`; there is no backtest-run scope yet.
- `packages/backtesting/`
  - Does not exist yet.
- LLM/provider surfaces
  - There is no LLM strategy, no prompt/output persistence, no provider call layer, and no replay-regression runner in the repo today.

---

## Resolved Implementation Decisions (2026-05-25)

These decisions remove ambiguity and make the work directly implementable.

1. **Extract one concrete engine helper, not a plugin framework.**
   - Add `packages/engine/src/trading-cycle.ts` with a reusable `runTradingCycle()` helper plus its input/output types.
   - Keep worker-only concerns in `TradingActor`: timers, private/public stream lifecycle, reconciliation loop ownership, pause/crash handling, and shadow pending-limit resolution.

2. **Replay owns frame stepping; the engine helper only needs a clock.**
   - Do not invent a scheduler abstraction inside `engine`.
   - `ReplayRunner` advances the simulated clock and calls `runTradingCycle()` for each replay frame.

3. **Keep the existing `Strategy` port for Phase 3.**
   - Do not add a new public `StrategyEngine` or `MarketContext` package boundary in this batch.
   - Use `MarketSnapshot.data` for normalized replay context when a strategy needs more than `symbol/price/timestamp`.

4. **Strategy runtime dispatch keys off `config.strategy.type`.**
   - `trading_instances.strategy_id` remains operator/catalog metadata for now.
   - Runtime selection should not depend on that column until a real strategy registry exists.

5. **Validate strategy params at the schema boundary.**
   - Replace the loose `strategy.params: Record<string, unknown>` shape with a discriminated union in `TradingInstanceConfigSchema` for at least `momentum` and `llm`.
   - `TradingActor` should pass `config.strategy.params`, not the whole instance config blob, into `Strategy.evaluate()`.

6. **Reuse the existing `decisions` table instead of creating a parallel live-decision store.**
   - Add a `DecisionRepository` and persist live/shadow/backtest decisions there.
   - Store heavier replay payloads separately (`decision_contexts`, `llm_decision_artifacts`) rather than bloating the base decision row.

7. **Journal reuse point: extend the existing journal table with `backtest_run_id`.**
   - Do not create a second append-only journal table.
   - Backtest journal events should use the same event taxonomy and query path as live events, scoped by `backtest_run_id`.

8. **Backtests run as bounded BullMQ jobs through the existing API/worker deployment.**
   - Add a dedicated `backtest-runs` queue and `BacktestRuntime` in `apps/worker`.
   - Do not overload `WorkerRuntime`, which should remain the long-lived actor coordinator.
   - Do not start with a CLI-first path in this phase.

9. **Implement one concrete `LLMStrategy` in `packages/strategy`.**
   - Provider call code can live in a non-exported helper inside the strategy package.
   - Do not add a new cross-package provider plugin interface in Phase 3; Section 21.2 still applies.

10. **Phase 3 replay fidelity stops at top-of-book/trade/candle replay.**
   - Queue-position simulation, pessimistic fill modeling, and full book-depth capture stay deferred.
   - Shadow-style limit-order replay may be supported with recorded trades, but it must reuse the same runner and not fork the execution path.

---

## Concrete Execution Plan

### 1. Extract the reusable trading-cycle runner

**Files to add/modify**

- Add `packages/engine/src/trading-cycle.ts`
- Modify `packages/engine/src/index.ts`
- Modify `apps/worker/src/trading-actor.ts`
- Add `packages/engine/src/trading-cycle.test.ts`

**Change**

- Move the core scan-cycle path out of `TradingActor.tick()` into `runTradingCycle()`:
  - strategy evaluation
  - decision stamping/persistence hooks
  - plan creation
  - risk evaluation
  - executor call
  - fill/order/position persistence hooks
- Keep actor-only lifecycle behavior in `TradingActor`:
  - timer ownership
  - reconciliation startup/stop
  - private stream pause/resume
  - shadow `resolvePendingLimits()` handling
  - stop/crash guards
- Inject a minimal clock dependency (`now(): string` or `Date`) so replay can run deterministically without inventing a second engine stack.
- Make the helper return a structured result that both the worker and backtest runner can assert on in tests.

**Dependencies**

- None. This is the first implementation step because every later Phase 3 feature depends on reusing the current worker path.

**Risk / open question**

- `TradingActor.tick()` currently mixes pre-execution shadow-limit resolution with the main decision path.
- Keep pending-limit resolution actor-owned in this step. Do not force that logic into `runTradingCycle()` unless a replay requirement proves it must move.

**Focused validation**

- Add engine-level tests proving the same input snapshot and position state produce the same decision/plan/order/fill result under a real clock and a simulated clock.
- Update worker tests only as needed to prove `TradingActor` now delegates into the helper without changing behavior.

### 2. Normalize strategy config handoff and persist canonical decisions

**Files to add/modify**

- Modify `packages/domain/src/config/schema.ts`
- Modify `apps/worker/src/index.ts`
- Modify `apps/worker/src/trading-actor.ts`
- Modify `packages/strategy/src/momentum.ts`
- Modify `packages/db/src/repositories.ts`
- Modify `packages/db/src/index.ts`
- Add/modify tests in `packages/strategy/src/momentum.test.ts`
- Add/modify tests in `apps/worker/src/trading-actor.test.ts`

**Change**

- Replace the loose strategy config shape with a discriminated union:
  - `strategy.type === 'momentum'` -> typed momentum params
  - `strategy.type === 'llm'` -> typed LLM params placeholder/schema
- Replace the hardcoded `new MomentumStrategy(...)` in `apps/worker/src/index.ts` with a small strategy factory keyed by `config.strategy.type`.
- Pass `config.strategy.params` to `Strategy.evaluate()` instead of the whole instance config blob.
- Add `DecisionRepository.insertDecision()` and persist every emitted decision before journal append.
- Preserve `Decision.contextHash` and `Decision.metadata` because later replay/LLM validation depends on them.

**Dependencies**

- Depends on step 1 so both the worker and replay runner can use the same decision persistence hooks.

**Risk / open question**

- `trading_instances.strategy_id` and `config.strategy.type` currently overlap conceptually.
- For Phase 3, treat `config.strategy.type` as the runtime source of truth and leave `strategy_id` unchanged.

**Focused validation**

- Strategy unit tests prove typed momentum params still parse correctly.
- Worker tests prove the actor now persists decisions and still executes a momentum decision end-to-end.

### 3. Scaffold `packages/backtesting` around the extracted engine path

**Files to add/modify**

- Add `packages/backtesting/package.json`
- Add `packages/backtesting/tsconfig.json`
- Add `packages/backtesting/src/index.ts`
- Add `packages/backtesting/src/simulated-clock.ts`
- Add `packages/backtesting/src/historical-data-feed.ts`
- Add `packages/backtesting/src/replay-runner.ts`
- Add `packages/backtesting/src/backtest-report.ts`
- Add tests under `packages/backtesting/src/*.test.ts`
- Modify `tsconfig.json`
- Modify `vitest.config.ts`

**Change**

- Create a new package that owns replay/backtest concerns without duplicating engine logic.
- Implement:
  - `SimulatedClock`
  - ordered historical frame types
  - `HistoricalDataFeed`
  - `ReplayRunner`
  - `BacktestReport`
- `ReplayRunner` should only own:
  - warm-up handling
  - clock advancement
  - iteration over historical frames
  - aggregation of final metrics/report output
- Execution logic must still go through `runTradingCycle()` with `PaperExecutor` for the initial backtest path.
- Keep optional shadow-style replay in the same package and on the same runner path; do not create a second replay engine.

**Dependencies**

- Depends on steps 1 and 2.

**Risk / open question**

- The phrase “no separate backtest loop” in the design record means “no separate execution logic,” not “no frame iterator.”
- `ReplayRunner` may own iteration, but all decision/risk/plan/execute logic must remain shared.

**Focused validation**

- Backtesting unit tests prove warm-up behavior, deterministic clock advancement, and stable report generation for a fixed corpus.

### 4. Build the replay corpus and decision-context persistence

**Files to add/modify**

- Add `packages/db/src/schema/decision-contexts.ts`
- Add `packages/db/src/schema/replay-corpora.ts`
- Add `packages/db/src/schema/replay-market-events.ts`
- Modify `packages/db/src/schema/index.ts`
- Add `packages/db/src/backtesting-repository.ts`
- Modify `packages/db/src/index.ts`
- Generate matching Drizzle migration files in `packages/db/drizzle/`
- Add `packages/backtesting/src/market-data-recorder.ts`
- Add `packages/backtesting/src/importers/` (CSV and venue-history import path)
- Modify `apps/worker/src/index.ts`
- Modify `apps/worker/src/trading-actor.ts`

**Change**

- Introduce a versioned replay corpus format:
  - corpus metadata row
  - append-only normalized market-event rows keyed by corpus, venue, symbol, event type, and event time
- Persist normalized decision inputs into `decision_contexts` keyed by decision id/context hash.
- The stored context must be sufficient to reconstruct what the strategy saw at decision time:
  - market snapshot
  - current position
  - reference mark
  - latest balance snapshot or explicit null
  - strategy params snapshot
  - any additional normalized context placed into `MarketSnapshot.data`
- Record the live inputs the engine actually uses for replay:
  - top-of-book / ticker snapshots
  - trade prints
  - candle windows if strategy logic depends on them
  - reference marks used by risk checks
- Add importers that write external history into the same corpus shape.
- Enforce loud failure on missing or gapped history; no silent interpolation.

**Dependencies**

- Depends on step 3 because the replay package should own the corpus format and importer/recorder helpers.

**Risk / open question**

- The worker does not maintain a per-tick balance model today.
- For the first implementation, persist the latest available balance snapshot or explicit null in `decision_contexts`; do not block Phase 3 on rebuilding per-tick balance state.

**Focused validation**

- Repository tests cover corpus writes and gap detection.
- Importer tests prove CSV/external history normalizes into the same event format used by the live recorder.

### 5. Persist backtest runs and expose the operator surface

**Files to add/modify**

- Add `packages/db/src/schema/backtest-runs.ts`
- Modify `packages/db/src/schema/journal-events.ts`
- Modify `packages/db/src/schema/index.ts`
- Modify `packages/db/src/journal-pg.ts`
- Modify `packages/engine/src/journal.ts`
- Modify `packages/engine/src/journal-memory.ts`
- Modify `packages/db/src/backtesting-repository.ts`
- Modify `packages/db/src/index.ts`
- Generate matching Drizzle migration files in `packages/db/drizzle/`
- Add `apps/api/src/routes/backtests.ts`
- Modify `apps/api/src/index.ts`
- Modify `apps/api/src/schemas.ts`
- Modify `apps/api/src/types.ts`
- Add `apps/worker/src/backtest-runtime.ts`
- Modify `apps/worker/src/index.ts`

**Change**

- Add `backtest_runs` with at least:
  - config snapshot
  - source instance or source strategy type
  - corpus source/window
  - execution mode
  - status
  - summary metrics
  - error payload
  - started/completed timestamps
- Extend `journal_events` with optional `backtest_run_id` so replayed decision/plan/order/fill/risk events use the same taxonomy as live events.
- Add a dedicated BullMQ queue and job type for bounded backtest runs.
- Add API endpoints to:
  - create a run
  - query status
  - fetch report/metrics
  - fetch run-scoped journal output
- Keep this runtime separate from `WorkerRuntime`; backtests are jobs, not long-lived actors.

**Dependencies**

- Depends on steps 3 and 4.

**Risk / open question**

- Existing API route patterns are instance-centric.
- Add a parallel backtest route module instead of forcing replay semantics into `/instances` routes.

**Focused validation**

- API tests or integration tests cover run creation/status/report retrieval.
- Worker tests prove a `BacktestJob` reaches `ReplayRunner`, persists status transitions, and writes journal output scoped by `backtest_run_id`.

### 6. Implement `LLMStrategy` and persist audit artifacts

**Files to add/modify**

- Add `packages/strategy/src/llm.ts`
- Add `packages/strategy/src/llm-provider.ts` or equivalent internal helper (non-exported)
- Modify `packages/strategy/src/index.ts`
- Add `packages/strategy/src/llm.test.ts`
- Add `packages/db/src/schema/llm-decision-artifacts.ts`
- Modify `packages/db/src/schema/index.ts`
- Modify `packages/db/src/backtesting-repository.ts`
- Modify `packages/db/src/index.ts`
- Modify `packages/domain/src/config/schema.ts`
- Modify `config/default.yaml`
- Modify `apps/worker/src/index.ts`
- Generate matching Drizzle migration files in `packages/db/drizzle/`

**Change**

- Add one concrete `LLMStrategy` that implements the existing `Strategy` port.
- Validate `strategy.type === 'llm'` params at the API boundary, including:
  - pinned provider name
  - pinned model version
  - prompt version
  - token/timeout limits
  - any required instrument/context settings
- Persist `llm_decision_artifacts` for every LLM decision:
  - decision id
  - context hash
  - normalized context payload
  - prompt payload / prompt version
  - raw provider response
  - parsed structured decision
  - parse status / failure details
  - provider/model identifiers
  - cache-hit vs live-call marker
- Keep provider credentials in operator secrets/env only; they must never be stored in instance config or the replay corpus.

**Dependencies**

- Depends on steps 2, 4, and 5.

**Risk / open question**

- There is no existing provider abstraction in the repo, and Section 21.2 warns against premature plugin layers.
- Start with one concrete provider integration inside `packages/strategy`; multi-provider support can be a later refactor if it becomes real.

**Focused validation**

- Unit tests prove prompt building, response parsing, context-hash caching, and artifact persistence for both success and parse-failure paths.

### 7. Add replay comparison and regression validation

**Files to add/modify**

- Add `packages/backtesting/src/validation-runner.ts`
- Add `packages/backtesting/src/context-replay.ts`
- Add/modify tests under `packages/backtesting/src/*.test.ts`
- Modify `apps/api/src/routes/backtests.ts` if diff/report retrieval needs separate endpoints

**Change**

- Add a replay validation path that runs a mechanical baseline and the LLM strategy against the same corpus or stored decision contexts.
- Diff at least:
  - intent direction
  - target size
  - go-flat transitions
  - downstream P&L/equity metrics
- Persist the comparison summary on `backtest_runs` and expose it via the operator API.
- Keep CI deterministic:
  - recorded corpora
  - stored decision contexts
  - mocked provider responses
- Reserve live provider evaluation for explicit validation runs only.

**Dependencies**

- Depends on step 6.

**Risk / open question**

- Thresholds must be strict enough to catch regressions but stable enough not to flap.
- Put those thresholds in operator config, not hard-coded in the runner.

**Focused validation**

- Regression tests prove prompt/model changes surface explicit diffs rather than silently changing behavior.

---

## Test Strategy

### Unit tests

- `packages/engine/src/trading-cycle.test.ts`
  - parity of decision/plan/risk/execute output under real vs simulated clocks
- `packages/strategy/src/momentum.test.ts`
  - strategy params now come from `config.strategy.params`
- `packages/strategy/src/llm.test.ts`
  - prompt building, parse behavior, caching, error handling
- `packages/backtesting/src/*.test.ts`
  - simulated clock, historical feed ordering, warm-up behavior, report aggregation, validation diffs
- `packages/db/src/backtesting-repository.ts` and `packages/db/src/repositories.ts`
  - decision writes, corpus writes, backtest-run status transitions, artifact persistence

### Integration-style tests

- `apps/worker/src/trading-actor.test.ts`
  - actor delegates to `runTradingCycle()` without changing worker lifecycle behavior
  - decision persistence happens before journal append
  - recorder/context hooks receive the same data used by the worker path
- `apps/worker/src/runtime.test.ts`
  - `WorkerRuntime` remains lifecycle-only and unchanged by backtest-job support
- New backtest runtime tests in `apps/worker/src/backtest-runtime.test.ts`
  - bounded BullMQ jobs execute and persist status/report/journal output correctly
- API route tests for `apps/api/src/routes/backtests.ts`
  - create -> status -> report/journal query flow

### Explicit validation runs (non-CI)

- Run one bounded backtest against imported historical data and one against live-recorded corpus data.
- Run one mechanical-vs-LLM comparison on the same corpus window.
- Verify the backtest journal and final report are queryable through the API.

### Required repo-level validation before Phase 3 is considered complete

- `pnpm test`
- `pnpm lint`

---

## Configuration Additions

### Operator config (`config/default.yaml` + `packages/domain/src/config/schema.ts`)

Add these operator-owned sections:

```yaml
backtesting:
  warmupLookbackBars: 200
  maxDataGapMs: 60000
  persistJournal: true

marketDataRecording:
  enabled: true
  captureTrades: true
  captureTopOfBook: true
  captureCandles: true

llmValidation:
  requirePinnedModel: true
  minReplayContexts: 100
  maxDecisionDivergencePct: 20
  maxPnlRegressionPct: 10
```

### Instance config (`trading_instances.config`)

Make `strategy` a discriminated union instead of an untyped blob.

Example LLM instance shape:

```yaml
strategy:
  type: llm
  params:
    instrumentId: SOL/USDC
    provider: openai
    model: gpt-5.4-mini
    promptVersion: llm-v1
    maxTokens: 1200
    temperature: 0
```

The model/provider identity belongs in instance config because it is part of the strategy definition. Provider credentials do not.

---

## Exit Criteria (Phase 3)

- [ ] `packages/backtesting` exists and replays bounded windows through the same engine trading-cycle code used by the worker runtime.
- [ ] Live and replay paths both persist canonical decision rows plus replayable decision context artifacts.
- [ ] Replay corpora can be recorded from live operation or imported from external history without silent gaps.
- [ ] `backtest_runs` persist status, summary metrics, and run-scoped journal output queryable through the API.
- [ ] Strategy runtime selection is no longer hardcoded to Momentum; `config.strategy.type` drives construction.
- [ ] `LLMStrategy` runs against replay/shadow contexts with pinned model metadata and stored prompt/output artifacts.
- [ ] A mechanical-vs-LLM comparison report exists for the same corpus window and highlights decision/P&L divergence.
- [ ] Residual modeling limits are documented explicitly where replay still differs from paper/shadow/live behavior.
- [ ] All existing tests pass (`pnpm test`) and type-check passes (`pnpm lint`).

---

## Backlog (deferred beyond core Phase 3 scope)

- [ ] Queue-position simulation for resting limit orders
- [ ] Pessimistic fill modeling (latency, partial fills, adverse selection)
- [ ] Full depth/orderbook capture for richer replay
- [ ] Multi-provider LLM support behind a stable plugin boundary
- [ ] Manual-user execution path from [003-design-decisions.md](003-design-decisions.md) Section 10.1
- [ ] Live LLM rollout remains Phase 4 after replay and shadow evidence