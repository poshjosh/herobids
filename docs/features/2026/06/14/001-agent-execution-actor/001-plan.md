# Agent Trading Actor

## Problem Statement

Agents cannot trade directly in shadow or live mode. The `AgentIntakeResolver` hardcodes a `PaperExecutor` and trivial risk limits for every `submit_decision` call, regardless of the agent's configured execution mode. This means agents that want to trade shadow/live must create a bot first — they cannot act like a human trading directly.

The root cause is structural: shadow/live execution requires long-lived infrastructure (venue connections, market data feeds, private streams, reconciliation loops) but the agent's direct trading path is stateless per-decision.

## Current State

```
Agent calls submit_decision
  → publishes to inbound Redis stream
  → AgentMessageBroker routes to AgentDecisionHandler
  → intakeResolver.getIntakeDeps(agentId, instrumentId)
      → actorRegistry.get(agentId) → miss (no actor registered for agents)
      → fallback: AgentIntakeResolver.getIntakeDeps()
          → resolves binding (capability_grants → trading_bindings → venue_accounts)
          → constructs PaperExecutor (hardcoded)
          → returns DecisionIntakeDeps with mega risk limits
  → submitDecisionForExecution(...)
```

**Blockers identified:**
1. Hardcoded `PaperExecutor` — no shadow/live capability
2. No venue port, swap venue, or venue type passed — planner always emits `'market'` orders
3. No proper risk limits — no connection to agent's `capital`, `dailyLossLimit`
4. No reconciliation for agent-direct positions
5. No credential audit trail for agent-direct executions
6. No mark-based drawdown tracking in risk context

## Target State

```
Agent session starts
  → AgentSessionManager creates AgentTradingActor(agentId, executionMode, binding)
  → actorRegistry.set(agentId, agentTradingActor)
  → actor starts (venue adapter, market data feed, reconciler — as needed)

Agent calls submit_decision
  → (same routing as before)
  → intakeResolver.getIntakeDeps(agentId, instrumentId)
      → actorRegistry.get(agentId) → HIT (AgentTradingActor found)
      → actor.getIntakeDeps(instrumentId) → correct executor, risk limits, venue deps
  → submitDecisionForExecution(...)

Agent session ends
  → actorRegistry.delete(agentId)
  → actor.stop() (tears down venue infra)
```

## Architecture

### New Components

#### 1. `ExecutionActor` interface

The shared contract for decision routing. Both `TradingActor` and `AgentTradingActor` implement it.

**Location:** `apps/worker/src/execution-actor.ts`

The existing `InstanceActor` interface is bot/WorkerRuntime-specific (`botId: string`, BullMQ lifecycle). The `actorRegistry` only needs the decision-routing surface. `ExecutionActor` captures exactly that:

```typescript
export interface ExecutionActor {
  readonly isRunning: boolean;
  getIntakeDeps(instrumentId?: string): DecisionIntakeDeps | undefined;
  getDecisionContext(instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined>;
  getPosition(instrumentId?: string): PositionState | undefined;
}
```

The registry becomes:
```typescript
const actorRegistry = new Map<string, ExecutionActor>();
```

Relationship to existing interfaces:
- `TradingActor implements InstanceActor, ExecutionActor` — bots keep their WorkerRuntime lifecycle contract
- `AgentTradingActor implements ExecutionActor` — agents have their own lifecycle (AgentSessionManager + Docker), no BullMQ involvement
- `InstanceActor` stays unchanged and scoped to `WorkerRuntime`

#### 2. `VenueAdapterFactory`

Shared factory extracted from the bot startup path. Both `TradingActor` (bots) and `AgentTradingActor` use it.

**Location:** `apps/worker/src/venue-adapter-factory.ts`

**Responsibilities:**
- Resolve credentials from `venueAccounts.credentialId` → `userCredentials` → decrypt
- Construct `OrderbookVenuePort` adapters (Hyperliquid, Bybit) with rate limiters
- Construct `SwapVenuePort` adapters (Jupiter, 1inch) with wallet resolution
- Construct `SwapTokenSafetyPort` when available
- Emit `credentialDecryptedEvent` for audit

**Interface:**
```typescript
interface VenueAdapterFactory {
  buildOrderbookAdapter(opts: {
    venueAccountId: string;
    venue: string;
    actorType: string;
    actorId: string;
  }): Promise<OrderbookAdapterResult>;

  buildSwapAdapter(opts: {
    venueAccountId: string;
    venue: string;
    swapAssets: SwapAssets;
    actorType: string;
    actorId: string;
  }): Promise<SwapAdapterResult>;
}

interface OrderbookAdapterResult {
  venuePort: OrderbookVenuePort;
  credentials: { apiKey: string; secret: string; testnet: boolean };
  credentialId: string;
}

interface SwapAdapterResult {
  swapVenue: SwapVenuePort;
  swapTokenSafety?: SwapTokenSafetyPort;
  walletAddress: string;
}
```

#### 3. `AgentTradingActor`

Long-lived, multi-instrument execution context for agent-direct trading.

**Location:** `apps/worker/src/agent-trading-actor.ts`

**Responsibilities:**
- Own venue infrastructure lifecycle (adapter, market data feed, private stream, reconciler)
- Track positions per instrument (`Map<instrumentId, PositionState>`)
- Implement `ExecutionActor` interface for decision routing
- Provide risk limits derived from agent config
- Support paper/shadow/live execution modes
- Rehydrate positions from DB on start
- Run reconciliation loop for shadow/live modes

**Key properties:**
- One per agent (not per instrument)
- Lifecycle aligned with agent runtime session
- Registered in `actorRegistry` under the agent's ID
- Multi-instrument: any instrument the agent targets is handled

**Interface:**
```typescript
interface AgentTradingActorDeps {
  agentId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  venueAccountId: string;
  venue: string;
  venueType: 'orderbook' | 'swap';
  swapAssets?: SwapAssets;
  riskLimits: RiskLimits;
  venueAdapterFactory: VenueAdapterFactory;
  streamPool?: StreamPoolHandle;
  markSource: MarkSource;
  journal: Journal;
  idGen: IdGenerator & { planId(): string };
  // Repositories
  positionRepo: PositionRepository;
  fillRepo: FillRepository;
  planRepo: ExecutionPlanRepository;
  orderRepo: OrderRepository;
  decisionRepo: DecisionRepository;
  balanceSnapshotRepo: BalanceSnapshotRepository;
  backtestingRepo: BacktestingRepository;
  reconciliationRepo: ReconciliationEventRepository;
  // Reconciliation config
  reconciliationConfig?: ReconcilerConfig;
  // Swap safety
  swapTokenSafety?: SwapTokenSafetyPort;
  swapNetwork?: string;
  swapBaseTokenAddress?: string;
}

class AgentTradingActor implements ExecutionActor {
  readonly agentId: string;
  readonly isRunning: boolean;

  constructor(deps: AgentTradingActorDeps);

  start(): Promise<void>;
  stop(): Promise<void>;

  // ExecutionActor implementation
  getIntakeDeps(instrumentId: string): DecisionIntakeDeps;
  getDecisionContext(instrumentId: string): Promise<DecisionContext | undefined>;
  getPosition(instrumentId: string): PositionState;
}
```

### Modified Components

#### `intakeResolver` (in `apps/worker/src/index.ts`)

Minimal logic change: widen the registry type from `Map<string, TradingActor>` to `Map<string, ExecutionActor>`. The existing routing already checks `actorRegistry.get(id)` first. Once the `AgentTradingActor` is registered, it's found naturally:

```typescript
const actorRegistry = new Map<string, ExecutionActor>();

const intakeResolver: DecisionIntakeResolver = {
  getIntakeDeps: (instanceId, instrumentId) => {
    const actor = actorRegistry.get(instanceId);
    if (actor?.isRunning) return actor.getIntakeDeps(instrumentId); // ← already works
    if (instrumentId) return agentIntakeResolver.getIntakeDeps(instanceId, instrumentId);
    return undefined;
  },
  // ...
};
```

#### `AgentSessionManager`

Add actor lifecycle calls:
- On session start: construct and register `AgentTradingActor`
- On session end: stop and deregister the actor

#### `AgentIntakeResolver`

Becomes the **paper-only fallback** for agents without a running execution actor (testing, agents with no binding, degraded mode). No changes needed — its scope just narrows.

#### Bot startup path in `index.ts`

Refactor to use `VenueAdapterFactory` instead of inline credential resolution + adapter construction. This is a refactor with no behavior change.

### Risk Limits Derivation

Agent config fields map to `RiskLimits`:

| Agent field | RiskLimits field | Notes |
|---|---|---|
| `capital` | `maxPositionSize` | The deployable allocation cap |
| `capital` | `maxOrderNotional` | Same cap applies per-order |
| `dailyLossLimit` | `maxDrawdown` | Maximum drawdown before halt |
| (default: 10) | `maxOpenPositions` | Configurable per-agent in future |

### Live Gate

Agent live-mode startup routes through `assertLiveReadiness()` — same check bots use. Ensures credentials are present, reconciliation is configured, and operator has enabled live trading.

## Implementation Checklist

### Phase 1: ExecutionActor interface + VenueAdapterFactory

- [ ] Define `ExecutionActor` interface in `apps/worker/src/execution-actor.ts`
- [ ] Make `TradingActor` implement `ExecutionActor` (add any missing methods)
- [ ] Widen `actorRegistry` type from `Map<string, TradingActor>` to `Map<string, ExecutionActor>`
- [ ] Extract credential resolution logic from bot startup path into `VenueAdapterFactory`
- [ ] Extract orderbook adapter construction (Hyperliquid, Bybit) into factory method
- [ ] Extract swap adapter construction (Jupiter, 1inch) into factory method
- [ ] Wire `VenueAdapterFactory` into worker `index.ts` as a shared singleton
- [ ] Refactor bot startup path to use the factory (no behavior change)
- [ ] Add unit tests for the factory

### Phase 2: AgentTradingActor

- [ ] Create `AgentTradingActor` class implementing `ExecutionActor`
- [ ] Implement multi-instrument position tracking (`Map<instrumentId, PositionState>`)
- [ ] Implement `getIntakeDeps(instrumentId)` returning correct executor per execution mode
- [ ] Implement `getDecisionContext(instrumentId)` using mark source
- [ ] Implement `getPosition(instrumentId)` with DB rehydration on start
- [ ] Implement risk limits derivation from agent config
- [ ] Add paper mode support (PaperExecutor, no venue deps)
- [ ] Add shadow mode support (ShadowExecutor + MarketDataFeed)
- [ ] Add live mode support (LiveExecutor + OrderbookVenuePort)
- [ ] Add reconciliation loop for shadow/live modes
- [ ] Add credential audit events (`credentialUsedEvent`)
- [ ] Wire `assertLiveReadiness()` gate on start
- [ ] Add unit tests

### Phase 3: Lifecycle Wiring

- [ ] Modify `AgentSessionManager` to create `AgentTradingActor` on session start
- [ ] Register the actor in `actorRegistry` under the agent's ID
- [ ] Stop and deregister the actor on session end
- [ ] Handle binding resolution at session start (determine venue, venueType, executionMode)
- [ ] Handle graceful degradation: if binding is not ready, fall back to paper-only resolver
- [ ] Add integration tests for the full lifecycle

### Phase 4: Cleanup & Safety

- [ ] Verify incomplete-plan recovery on worker restart for agent-originated plans
- [ ] Verify position rehydration across worker restarts
- [ ] Add `credentialDecryptedEvent` emission in the factory
- [ ] Verify `list_positions` tool correctly shows multi-instrument agent positions
- [ ] Run full test suite (`pnpm test && pnpm lint`)
- [ ] Validate via agent trade test script

## Design Decisions

### Why a new actor class instead of reusing TradingActor?

`TradingActor` is single-instrument and tightly coupled to its strategy scan loop. Agents are multi-instrument and externally driven (decisions arrive from LLM tool calls, not an internal loop). Forcing agents into `TradingActor` would require bolting on multi-instrument support and removing the scan loop — producing a Frankenstein that serves neither case well.

### Why not fatten up AgentIntakeResolver?

Shadow/live execution needs long-lived resources (venue connections, streams, reconciliation loops). A stateless resolver that constructs resources per-decision would either leak connections, miss fills between decisions, or produce incorrect reconciliation. The persistent actor pattern is the only sound approach for live execution.

### Why introduce ExecutionActor instead of widening InstanceActor?

`InstanceActor` is the lifecycle contract for `WorkerRuntime` (BullMQ-driven start/stop, bot leasing). Agent sessions are managed by `AgentSessionManager` (Docker containers, Redis heartbeats) — a completely different lifecycle. Forcing both into one interface would either bloat `InstanceActor` with optional fields or require the agent actor to implement bot-specific methods it doesn't need.

`ExecutionActor` captures only the decision-routing surface that both actor types share. Each keeps its own lifecycle contract:
- `TradingActor implements InstanceActor, ExecutionActor`
- `AgentTradingActor implements ExecutionActor`

### Why not rename TradingActor to BotTradingActor?

`TradingActor` is already unambiguous — scoped by file, constructor takes `botId`, used exclusively by `WorkerRuntime`. Renaming produces churn across dozens of files (tests, imports, runtime, broker) with zero clarity gain. The naming asymmetry (`TradingActor` vs `AgentTradingActor`) actually helps: the unprefixed name is the original/default, the prefixed name is the agent-specific variant.

### Why extract VenueAdapterFactory instead of sharing the whole bot startup?

The bot startup path does many bot-specific things (BotConfigSchema validation, strategy creation, journal setup). The only shared concern is "given a venue account, produce a configured venue adapter." The factory captures exactly that concern — no more, no less.

### Why register in the same actorRegistry as bots?

The `intakeResolver` routing already checks the registry. Adding agents to the same registry means zero changes to the decision routing path. The registry is keyed by actor ID (bot ID or agent ID), and these are already UUIDs in different namespaces, so no collisions.

## Out of Scope

- Per-instrument execution mode (all instruments on an agent share one mode)
- Agent position sizing optimization based on confidence scores
- Multi-venue-account support for a single agent (one binding = one venue account today)
- Strategy scan loops for agents (agents are LLM-driven, not strategy-driven)
