# Refactor Plan: Phase 4 — Executor Extraction

Extract reusable execution infrastructure from `TradingActor` so that agents can
execute decisions on arbitrary instruments without creating full bot entities.

**Source:** `apps/worker/src/trading-actor.ts` (1500+ lines)  
**Target:** `packages/engine/src/instrument-executor.ts`  
**Depends on:** Nothing (can proceed in parallel with Phases 1–3)

---

## Problem

`TradingActor` bundles strategy evaluation + execution into one class. The
technical phase (Phase 3) needs execution but not strategy evaluation. Currently
the only way to execute a decision on an instrument is to spin up an entire
`TradingActor` (heavyweight: reconciliation, private streams, swap recovery, etc.).

The agent's technical phase produces decisions for N instruments. It needs to
execute each decision through:
- Plan generation (decision → concrete orders)
- Risk gate (position size, drawdown, daily loss)
- Order submission (paper / shadow / live)
- Fill accounting (position updates, P&L)

These are all inside `TradingActor` today, tightly coupled to its lifecycle.

---

## What Moves Out

### Into `InstrumentExecutor` (new, reusable)

| Capability | Current Location in TradingActor |
|---|---|
| Plan generation (decision → order plan) | `runTradingCycle` → planner |
| Risk gate evaluation | `runTradingCycle` → risk checks |
| Order submission (paper executor) | `PaperExecutor` |
| Order submission (live executor) | `LiveExecutor` / `SwapLiveExecutor` |
| Fill persistence | `onFill` handler |
| Position state management | `this.position` + mutex |

### Stays In `TradingActor` (bot-specific)

| Capability | Why It Stays |
|---|---|
| Strategy evaluation (`strategy.evaluate()`) | Bots evaluate strategy; agents don't need this |
| Scan interval timer | Bots have their own tick loop |
| Private WebSocket stream | Bot lifecycle management |
| Reconciliation on startup | Bot-specific (existing position reconcile) |
| Swap recovery logic | Complex, bot-scoped |
| Circuit breaker state | Per-bot venue error tracking |

---

## Target Interface

```typescript
export interface InstrumentExecutorDeps {
  venue: string;
  symbol: string;
  venueAccountId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  venueType: 'orderbook' | 'swap';
  venuePort?: OrderbookVenuePort;
  swapVenue?: SwapVenuePort;
  riskLimits: RiskLimits;
  idGen: { planId(): string; orderId(): string; fillId(): string };
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  positionRepo: PositionRepository;
  journal: Journal;
  logger: Logger;
}

export interface ExecutionResult {
  executed: boolean;
  riskRejected: boolean;
  fills: Fill[];
  newPosition: PositionState;
  error?: string;
}

/**
 * Executes a single decision on a specific instrument.
 * Stateless per call — position state is passed in and returned.
 */
export async function executeDecision(
  decision: Decision,
  currentPosition: PositionState,
  deps: InstrumentExecutorDeps,
): Promise<ExecutionResult>
```

---

## Migration Strategy

### Step 1: Extract Without Breaking

1. Create `packages/engine/src/instrument-executor.ts`
2. Move plan generation + risk gate + execution logic into it
3. `TradingActor` delegates to `executeDecision()` internally
4. All existing bot behavior unchanged (refactor, not rewrite)

### Step 2: Wire Into Agent

1. Agent's technical phase calls `executeDecision()` directly
2. One `InstrumentExecutorDeps` per venue account (shared across instruments)
3. Position state managed in agent's `Map<instrumentId, PositionState>`

### Step 3: Simplify TradingActor

1. `TradingActor.tick()` becomes: fetch price → evaluate strategy → `executeDecision()`
2. Remove duplicated execution logic from TradingActor
3. Bot-specific concerns (reconciliation, streams, recovery) stay

---

## Checklist

### Extraction

- [ ] Identify exact code sections in `TradingActor` that handle execution
- [ ] Create `packages/engine/src/instrument-executor.ts`
- [ ] Define `InstrumentExecutorDeps` interface
- [ ] Define `ExecutionResult` type
- [ ] Extract plan generation logic
- [ ] Extract risk gate checks
- [ ] Extract paper executor path
- [ ] Extract live executor path (orderbook)
- [ ] Extract live executor path (swap)
- [ ] Extract fill persistence logic
- [ ] Export from `packages/engine/src/index.ts`

### Integration (TradingActor)

- [ ] `TradingActor` delegates to `executeDecision()` in its tick
- [ ] All existing bot tests pass without modification
- [ ] No behavior change for running bots

### Integration (Agent)

- [ ] Agent technical phase imports `executeDecision()`
- [ ] Agent manages `Map<instrumentId, PositionState>` internally
- [ ] Agent executes N decisions per scan cycle via the executor

### Tests

- [ ] Unit test `executeDecision()` with paper mode (mock deps)
- [ ] Risk gate rejects oversized position
- [ ] Risk gate rejects when daily loss exceeded
- [ ] Paper executor produces realistic fills
- [ ] Fill persistence called correctly
- [ ] Position state updated after execution
- [ ] Existing TradingActor tests unchanged and passing

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Large refactor in critical path | Step 1 is purely extractive — delegates internally, no behavior change |
| Position state concurrency | Agent uses sequential scan loop (no parallel execution per instrument) |
| Swap execution complexity | Initial extraction covers orderbook only; swap support in follow-up |

---

## Definition of Done

- [ ] `executeDecision()` works standalone with paper mode
- [ ] `TradingActor` delegates to it (no behavior change)
- [ ] Agent technical phase can call it for multi-instrument execution
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No new dependencies added
