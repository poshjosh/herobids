# Phase 3: Backtesting + LLM Validation

**Goal:** Run the same decision -> risk -> plan -> execute pipeline against historical and replayed data, compare outcomes to paper/shadow runs, and gate LLM strategies with reproducible replay evidence before live capital.

**Parent:** [003-design-decisions.md](../2026/05/initial/003-design-decisions.md) Section 15, Section 20

**Depends on:** [008-phase-2c-plan.md](../2026/05/initial/008-phase-2c-plan.md) exit criteria and the Phase 2 shadow/reconciliation surfaces already in place

**Scope note:** This plan follows the build-phase sequence in [003-design-decisions.md](../2026/05/initial/003-design-decisions.md) Section 20. The manual-user actor mentioned in Section 10.1 stays deferred until replay and validation are in place.

---

## 1. Extract the reusable engine runner (Section 15.1)

The current executor and market-data seams are already present. The missing reuse point is the worker-owned scan loop and time model in `apps/worker/src/trading-actor.ts`.

- [ ] Extract one reusable scan-cycle path from `TradingActor.tick()` into engine-owned runtime code that both worker actors and backtests can call
- [ ] Reuse the existing `Executor`, `PaperExecutor`, `ShadowExecutor`, and `MarketDataFeed` surfaces; do not create a second planner or executor stack for backtesting
- [ ] Introduce runtime-local time injection (`now`, advance/schedule hooks) so replay can drive simulated time without inventing a separate engine loop
- [ ] Keep this as concrete engine/backtesting code, not a new cross-package plugin system; [003-design-decisions.md](../2026/05/initial/003-design-decisions.md) Section 21.2 still applies
- [ ] Add focused tests proving the same snapshot produces the same decision/plan/order/fill sequence under real and simulated runtimes

## 2. Scaffold `packages/backtesting` (Section 15.1, Section 20)

- [ ] Create `packages/backtesting/` with `package.json`, `tsconfig.json`, and `src/index.ts`
- [ ] Implement `SimulatedClock`, `HistoricalDataFeed`, `ReplayRunner`, and `BacktestReport` types
- [ ] Backtesting injects `SimulatedClock` + `HistoricalDataFeed` + `PaperExecutor` into the same engine path used by the worker; no separate backtest loop
- [ ] Support warm-up windows so strategies can rebuild indicator buffers and cold-start safely before the first evaluable tick
- [ ] Run bounded backtests as one-shot BullMQ jobs or a CLI entrypoint, not as long-lived actors
- [ ] Keep `ShadowExecutor` replay as an optional validation mode driven by recorded ticker/trade data, not a forked implementation

## 3. Build the replay corpus and market-data recorder (Section 14.1, Section 15.2)

- [ ] Persist the live market data needed to replay current engine behavior: ticker snapshots with bid/ask, trade prints, reference marks, and candle windows keyed by venue/instrument/time
- [ ] Record enough state to reconstruct decision inputs: positions, balances, risk-relevant marks, and strategy input snapshots at decision time
- [ ] Add importers for external history (CSV or venue historical endpoints) so replay is not blocked on waiting for new live recordings
- [ ] Detect and fail loudly on missing or gapped history instead of interpolating silently
- [ ] Version the replay-corpus format so richer depth/book capture can be added later without invalidating older runs

## 4. Persist backtest runs and expose an operator surface

- [ ] Add a `backtest_runs` table recording config snapshot, corpus source, time window, execution mode, strategy version, model version(s), status, and summary metrics
- [ ] Persist run-scoped journal output so every replayed decision, plan, order, fill, and risk rejection is auditable like a live run
- [ ] Expose an operator surface to start a backtest, inspect status, and fetch the final report/equity curve
- [ ] Compare backtest summaries against paper/shadow runs over the same window and surface divergence metrics as first-class output

## 5. Implement the LLM strategy validation path (Section 7.4, Section 15.3, Section 20)

- [ ] Implement `LLMStrategy` as a `Strategy` implementation that returns the existing `StrategyDecision[]` shape
- [ ] Pin provider and model versions; store them on every replay and shadow-validation run
- [ ] Persist the full prompt, normalized context payload, structured output, parse status, and context hash for every LLM decision
- [ ] Add context-hash caching so identical replay contexts can be evaluated cheaply while still leaving an audit trail of cache hits vs live provider calls
- [ ] Run the LLM and a mechanical baseline across the same corpus; diff direction, target size, go-flat transitions, and downstream P&L before considering live rollout

## 6. Add context replay and regression testing (Section 7.4, Section 15.3)

- [ ] Capture reusable decision corpora from paper/shadow runs: positions, balances, marks, indicators, market snapshots, prompt inputs, and expected decisions
- [ ] Add a regression suite that replays stored contexts across prompt/model changes and fails on schema drift, materially different intent, or degraded performance beyond configured thresholds
- [ ] Keep CI deterministic: recorded corpora and mocked provider responses in automated tests; live provider evaluation only in explicit validation runs
- [ ] Publish a per-run diff report showing exactly which contexts changed and why

## Exit Criteria (Phase 3)

- [ ] `packages/backtesting` can replay a bounded window using the same engine path as the worker runtime
- [ ] Historical/replayed runs persist journal-quality decision/order/fill/risk output plus a final report
- [ ] The market-data recorder or importer produces replayable corpora without silent gaps
- [ ] `LLMStrategy` runs against replayed/shadow contexts with pinned model versions and stored prompt/output artifacts
- [ ] A mechanical-vs-LLM comparison report exists for the same corpus and highlights decision/P&L divergence
- [ ] Backtest results are comparable to paper/shadow runs for the same window, with residual modeling gaps documented explicitly
- [ ] All existing tests pass (`pnpm test`) and type-check passes (`pnpm lint`)

## Configuration additions

```yaml
# config/default.yaml (additions)
backtesting:
  warmupLookbackBars: 200
  maxDataGapMs: 60000
  persistJournal: true

marketDataRecording:
  enabled: true
  captureTrades: true
  captureTopOfBook: true

llmValidation:
  requirePinnedModel: true
  minReplayContexts: 100
  maxDecisionDivergencePct: 20
```

```typescript
// packages/domain/src/config/schema.ts (additions)
export const BacktestingConfigSchema = z.object({
  warmupLookbackBars: z.number().int().min(0).default(200),
  maxDataGapMs: z.number().min(1_000).default(60_000),
  persistJournal: z.boolean().default(true),
});

export const MarketDataRecordingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  captureTrades: z.boolean().default(true),
  captureTopOfBook: z.boolean().default(true),
});

export const LlmValidationConfigSchema = z.object({
  requirePinnedModel: z.boolean().default(true),
  minReplayContexts: z.number().int().min(1).default(100),
  maxDecisionDivergencePct: z.number().min(0).max(100).default(20),
});
```

## Backlog (deferred beyond core Phase 3 scope)

- [ ] Queue-position simulation for resting limit orders
- [ ] Pessimistic fill modeling (latency, partial fills, adverse selection)
- [ ] Full depth/orderbook capture for richer replay
- [ ] Manual-user execution path from [003-design-decisions.md](../2026/05/initial/003-design-decisions.md) Section 10.1
- [ ] Live LLM rollout remains Phase 4 after replay and shadow evidence