# HeroBids Design Decision Record

## 0. Framing Decisions

### Who is the day-1 user?

A trusted operator or small set of known users — not arbitrary untrusted tenants running their own code. This assumption makes pooled workers, just-in-time secret decryption, and absence of container-per-bot isolation all acceptable.

### What is the v1 product?

A **trading engine plus a thin operator control plane**. Not a multi-tenant SaaS. Not a frontend-heavy product. Not an agent platform. Auth breadth, billing, autonomous agents, config marketplace, and a polished dashboard are all deferred until after the engine proves itself with real capital.

### What is the first strategy to validate?

The first orderbook venue should be chosen to match the first live strategy you intend to run profitably. Hyperliquid is the recommended starting venue — it's a perp DEX with no KYC, programmatic REST/WS access, ccxt support, and no CEX custody risk. But if the first real strategy trades spot swaps on Solana, start with Jupiter and add Hyperliquid as the second venue.

---

## 1. Architecture: Layer Decomposition

### Q1.1: Core data flow?

`Decision → Plan → Execution → Reconciliation`

- **Decision:** Strategy produces target exposure (`go_long BTC 0.5` or `go_flat ETH`)
- **Plan (Desire Layer):** Routes intent to specific venue(s) and produces execution commands
- **Execution:** Submits orders, manages lifecycle, records fills
- **Reconciliation:** Compares local state to venue state, detects and resolves drift

The old project conflates planning and execution inside `position-manager.ts`. HeroBids separates them.

### Q1.2: Should the "Desire Layer" be a distinct package or a module within `engine`?

A module within `packages/engine/src/routing/` initially. For v1 with one venue per asset, it simply maps (symbol, direction, size) → (venue, instrument, order type). It only warrants its own package if cross-venue netting or multi-leg splitting becomes real.

---

## 2. Venue Connectivity

### Q2.1: First orderbook venue?

Hyperliquid via ccxt. No KYC, programmatic access, ccxt support is mature, no CEX custody risk. Validates the orderbook abstraction without regulatory burden.

### Q2.2: ccxt vs. direct SDK?

Start with ccxt. Wrap it once, never expose its types. Only bypass if WebSocket stream quality is provably degraded.

### Q2.3: Do `OrderbookVenue` and `SwapVenue` share a parent interface?

No. They are fundamentally different (stateful order lifecycle vs. atomic swap). Unification happens one layer up, in the Plan/Routing layer, which decides which venue type to use and speaks the appropriate interface.

### Q2.4: SwapVenue interface shape?

`quote(SwapQuoteRequest) → execute(SwapQuote)` — chain-agnostic. `SwapQuoteRequest` contains `{ fromToken, toToken, amount, slippageBps }`. The venue implementation handles chain-specific details internally. The old `buy(tokenAddress, amountUsdc, slippageBps)` shape is too Solana-centric.

---

## 3. State Ownership & Position Model

### Q3.1: What owns live state — bot, portfolio, or venue account?

**Portfolio + venue account**, not bot. A live ledger is keyed by `(portfolio_id, venue_account_id)`. The v1 invariant is:

> **One trading instance per venue account. No exceptions.**

A venue account (wallet or exchange subaccount) is exclusively assigned to exactly one trading instance at any time. No sharing, no coordination, no multi-strategy writes to the same account. This gives each instance sole authority over its positions, simplifies reconciliation (all fills on this account belong to this instance), eliminates cross-strategy interference, and makes crash recovery deterministic.

If you want two strategies trading the same venue, create two subaccounts (most perp venues support this) or two wallets. The data model allows viewing one portfolio across multiple venue accounts for cross-venue P&L, but execution authority is never shared.

The old project's bot-owned `ActorState` (JSONB blob per bot) is replaced by normalized Postgres tables that represent positions, orders, and fills as first-class records.

### Q3.2: How does multi-venue intent resolution work?

This is the Plan layer's job. When the strategy emits `{ action: 'go_long', symbol: 'BTC', targetSize: 0.5 }`:
1. Query current positions for this portfolio across all venue accounts
2. Compute delta (current vs. target)
3. Select venue based on: cost, speed, available margin, configured routing rules
4. Emit venue-specific execution commands

For v1 with one venue per asset, this reduces to a lookup. Complexity scales with venue count.

### Q3.3: Position model?

Two concrete types:
- `SpotPosition` — token swaps: token, amount, cost basis, current value
- `DerivativePosition` — perps/futures: symbol, side, size, leverage, entry price, margin, unrealized P&L, liquidation price

The Plan layer works in terms of `TargetExposure { symbol, side, targetSize }` and the engine resolves which position type(s) to create or modify.

### Q3.4: Write-ahead for crash safety?

Before execution: persist `execution_plan` to Postgres with an idempotency key. After fill: persist `fill` record. On restart: check incomplete execution plans and reconcile against venue state. This replaces the old project's balance-check-before-sell workaround.

### Q3.5: Crash rehydration — what happens when a worker dies?

Since v1 uses long-lived actors (not container-per-bot), worker death is a first-order design concern. The rehydration contract:

1. **BullMQ detects death** via heartbeat timeout (configurable, e.g. 30s). The instance lease is released.
2. **Another worker picks up the lease** via BullMQ job reassignment.
3. **Actor rehydration on the new worker:**
   - **Positions, orders, fills:** Rebuilt from Postgres (normalized tables, not in-memory blobs). This is why state ownership moved to the database.
   - **Incomplete execution plans:** Detected by querying `execution_plans` with no corresponding `fill` or terminal state. Reconciled against venue (check if the order was actually placed/filled).
   - **Private stream subscriptions:** Re-established from the `venue_accounts` record. The new worker opens a fresh authenticated WebSocket to the venue account.
   - **Reconciliation cursor:** Stored in Postgres (`venue_accounts.last_reconciled_at`). The new worker runs an immediate reconciliation pass before resuming normal operation.
   - **Timers (scan interval, heartbeat):** Recreated fresh. No timer state is persisted — the actor simply starts its next scan cycle.
   - **Rate-limit state:** Lost. The new worker starts with a fresh rate-limit window. This is acceptable because rate limits are defensive (briefly exceeding internal soft limits on restart is safe; venue-enforced limits reject the request anyway).
   - **Strategy-local memory (LLM context cache, indicator buffers):** Lost. Strategies must be designed to cold-start: fetch enough candle history to recompute indicators, and accept one LLM call without cache benefit. The context hash cache in Redis survives worker death (it's external).

4. **Invariant:** No trading occurs between death detection and full rehydration. The actor does not resume its scan loop until positions are loaded and one reconciliation pass confirms local state matches venue state.

This contract means: all durable state lives in Postgres, all ephemeral caches are reconstructible, and the actor can cold-start on any worker without data loss.

---

## 4. Execution Lifecycle

### Q4.1: Unified lifecycle for all venue types

The full execution lifecycle exists as a **type-level concept for all venue types**:

```
intent → plan → submitted → acknowledged → partially_filled → filled → confirmed
                          → rejected
                          → cancelled
                          → expired
                          → failed_confirmation
```

Swap venues fast-path through this: `submitted → filled` in a single synchronous step. They produce the same `Fill` record, the same journal entries, and the same analytics shape as orderbook venues. This guarantees uniform observability, audit, and bug-fix reuse across venue types.

### Q4.2: How do partial fills interact with position tracking?

Each fill event updates the position's `filledSize` incrementally. The position is "open" once the first fill arrives. The state machine emits fill events that the position aggregator consumes. No new orders for the same instrument until the current order fully resolves (fill, cancel, or timeout).

### Q4.3: Where does the state machine live?

`packages/engine/src/execution/`. It is venue-agnostic — venue adapters translate venue-specific events into canonical lifecycle transitions.

---

## 5. Reconciliation

### Q5.1: How critical for v1?

First-class from day 1 for orderbook venues. Exchanges report positions, balances, and fills that diverge from local state (funding payments, liquidations, amended fills, out-of-band events). Even for swap venues, reconciliation confirms that on-chain balance matches expected state after a swap.

### Q5.2: What does it do?

A periodic reconciler (every 30–60s for orderbook venues):
1. Fetches venue state (positions, balances, recent fills)
2. Compares to local state
3. Emits `reconciliation_event` (match, drift detected, or repaired)
4. For v1: logs + alerts on drift. For v2: auto-corrects within configured thresholds.

Lives in `packages/engine/src/reconciliation/`.

---

## 6. Risk Layer

### Q6.1: Separate gate, not embedded in executor

The risk gate sits between Decision and Execution. It receives `StrategyDecision[]` and returns `ApprovedDecision[] | RejectedDecision[]`. Checks:
- Position size limits
- Leverage limits
- Drawdown circuit breaker (portfolio stop)
- Correlation limits
- Rate limits on new positions per time window

Lives in `packages/engine/src/risk/gate.ts`.

### Q6.2: Hard risk never yields to AI

The old project's `mechanicalExits: false` disables SL/TP enforcement when "the LLM owns exit decisions." This pattern does not survive into herobids.

**Non-negotiable rule:** Hard risk limits (max position size, max leverage, drawdown circuit breaker, portfolio stop) are always enforced in code. They never yield to AI preferences. Only advisory guidance (suggested entry timing, conviction weighting, preferred hold duration) belongs in prompts.

### Q6.3: Agent guardrails vs. risk gate?

These are complementary, not overlapping. Agent guardrails (daily loss limit, LLM token budget, allowed execution modes) are per-agent operational limits at the orchestration level. The risk gate is a per-trade/per-position enforcement mechanism in the engine. Both exist; neither replaces the other.

---

## 7. Strategy / AI Layer

### Q7.1: Strategy output format?

Target-state intent, not venue-specific actions:
```ts
interface StrategyDecision {
  action: 'go_long' | 'go_short' | 'go_flat' | 'hold';
  symbol: string;
  targetSize: number;        // required — conviction expressed as size
  conviction: number;        // 0–1
  reasons: string[];
  metadata?: Record<string, unknown>;
}
```

The engine derives actions (open, close, reduce, reverse) from the delta between current state and target state.

### Q7.2: Decision modes?

Three: `mechanical`, `llm`, `hybrid`. All produce the same `StrategyDecision[]` output. The interface is `StrategyEngine.analyze(context: MarketContext) → StrategyDecision[]`.

### Q7.3: MarketContext shape?

An extensible interface. Strategies declare what they need; the engine provides it. Contains: current positions, account state (balance, margin), and market data relevant to the strategy's instrument universe (candles, orderbook depth, funding rates, indicators, sentiment). This avoids a god-object.

### Q7.4: LLM validation path?

Pin model versions, record full prompt + context + output, hash contexts for caching, require paper → shadow evidence before live, use replayed contexts for regression tests.

---

## 8. Market Data

### Q8.1: Is token discovery a core engine concern?

No. The engine works with a **fixed universe of instruments** provided by configuration or a strategy-specific module. DexScreener, GeckoTerminal, Birdeye, CoinMarketCap are strategy inputs relevant to a Solana token-discovery strategy — not platform infrastructure.

These providers belong in strategy-specific data modules or in an optional `packages/market-data` package that strategies can depend on. The engine core never imports them.

### Q8.2: What market data does the engine core need?

Only what execution and reconciliation require: a **reference mark** (for risk checks and P&L), venue-reported positions and balances (for reconciliation), and order/fill events (for lifecycle tracking).

### Q8.4: Valuation policy — what is the canonical mark?

AMM/aggregator quotes are size-dependent, route-dependent, and noisy. Using a live executable quote as the portfolio mark causes paper, shadow, and live modes to disagree for non-bug reasons. The engine needs an explicit marking policy:

**Orderbook venues:** Mid-price from the venue's ticker stream. This is a standard, size-independent reference. The risk gate uses this for drawdown checks and portfolio stop.

**Swap venues (AMM/aggregator):** The mark is the **last fill price** for positions with recent fills, or a **reference price from a reliable oracle** (e.g., CoinGecko/Coinbase spot price, or the venue's own cached token price endpoint) for stale positions. Executable quotes (which are size- and route-dependent) are used only at the moment of execution, never as the standing mark.

**Rule:** The marking source is configured per instrument and recorded on each `balance_snapshot` and `position` record, so any P&L or risk decision can be audited back to its price source.

This separation means:
- Risk gate uses the reference mark (stable, auditable)
- Execution uses the executable quote (size-accurate, transient)
- Reconciliation compares local mark against venue-reported value
- Paper/shadow/live use the same marking source, preventing mode-specific P&L divergence

### Q8.3: Push vs. pull?

Both. WebSocket (ccxt Pro) for execution-critical data: order fills, position updates, real-time ticker. REST polling for strategy inputs at scan interval (candles, indicators). This distinction matters for connection sharing (see §10.3).

---

## 9. Persistence & Schema

### Q9.1: ORM and database?

Drizzle ORM + PostgreSQL + ioredis. Postgres is source of truth. Redis is cache, leases, pub/sub, and queues only. No event sourcing for v1 — use normalized current-state tables plus an append-only journal for auditability.

### Q9.2: Day-1 schema (normalized tables)

- `instruments` — canonical instrument registry (symbol, venue, type, tick size, lot size)
- `venue_accounts` — user's authenticated sessions on venues (credentials ref, subaccount ID)
- `credentials` — encrypted API keys/secrets per venue (separate from wallets)
- `portfolios` — logical grouping of positions across venues
- `trading_instances` — running trading configs with version history
- `decisions` — every strategy output, with context hash, for audit and replay
- `execution_plans` — plan layer output (desired-to-actual mapping)
- `orders` — mutable order lifecycle records (state machine)
- `fills` — immutable fill records (one order → many fills)
- `positions` — current position state (derived from fills, reconciled against venue)
- `balance_snapshots` — periodic balance captures per venue account
- `risk_events` — every risk gate rejection or circuit breaker trigger
- `reconciliation_events` — drift detection results
- `journal` — append-only audit log (all significant system events)

JSON summaries can exist for fast API reads, but they are derived read models, not canonical state.

### Q9.3: Identity and timestamp policy

- **IDs:** UUIDv7 (time-ordered, sortable, no coordination needed) for all primary keys. Store raw venue-assigned IDs alongside in a `venue_ref_id` column for reconciliation lookups.
- **Timestamps:** UTC everywhere. `timestamptz` in Postgres. ISO 8601 with `Z` suffix in logs and events. Never use local time.
- **Numerics:** `decimal.js` for money and prices. Native `bigint` for atomic chain units (wei, lamports). JavaScript `number` only for counters, durations, and display-only percentages.

---

## 10. Orchestration

### Q10.1: What actors exist?

Three actor types, implemented in phases:

1. **Bot** — A long-lived trading instance running server-controlled strategy code with user-provided parameters. Runs in-process within a pooled BullMQ worker. No container needed — all code is ours. *(Phase 1)*
2. **Agent** — An AI actor that generates trading decisions via LLM, may execute generated code, and may access external resources (internet, APIs). Runs in an isolated container with resource caps and egress rules. Communicates with its trading instance(s) via a message contract. *(Phase 2)*
3. **User (manual)** — A human issuing orders through the API/UI. No persistent process — just authenticated API calls that create orders through the same execution engine. *(Phase 3)*

All three produce the same output: a **Decision** (target exposure). The engine doesn't care who made the decision. The container boundary exists because of *how* an agent arrives at its decision (untrusted code execution), not because of what it produces.

**Trading instance** remains the core runtime unit — one strategy, one venue account. A bot owns exactly one trading instance. An agent may own one or more trading instances. A manual user's orders go through the execution engine directly (no persistent actor).

v1 validates the engine with bots (directly configured trading instances). Agents are phase 2.

### Q10.2: BullMQ role — lifecycle coordinator, not tick scheduler

BullMQ owns:
- **Lifecycle:** start, stop, restart, scheduled start/stop
- **Recovery:** detect worker death via heartbeat timeout, reassign actor lease
- **Coordination:** reconciliation sweeps, watchdog checks, deferred alerts

A running trading instance is a **long-lived leased actor** inside a worker process. The scan loop runs on a timer inside the actor, not as repeated BullMQ jobs. BullMQ's job is to ensure exactly one worker holds the lease for each active instance, and to recover the lease if the worker dies.

### Q10.3: Connection sharing — public vs. private streams

**Public market-data streams** (orderbook, ticker, candles): Shared across all trading instances on the same worker process via a connection pool keyed by venue. One WebSocket per venue per worker, with fan-out to interested actors.

**Private account streams** (orders, fills, positions, balances): **One authenticated stream per venue-account, consumed exclusively by the single trading instance that owns that account.** Since v1 enforces one-instance-per-venue-account (§3.1), there is no sharing of private streams. The stream belongs to the instance.

This distinction is critical: sharing private streams across users would leak order/position data. Sharing public streams is purely an optimization.

### Q10.4: Container isolation

**v1 (bots only):** Not needed. All strategy code is server-controlled. Pooled BullMQ workers with process-level isolation are sufficient.

**v2 (agents):** Required. Agents run AI-generated code, browse the internet, and call external APIs — this is untrusted execution regardless of whether a human or AI wrote it. Each agent gets its own container (or microVM) with:
- No access to host filesystem or other agents' memory
- Resource caps (CPU, memory, execution time)
- Network egress restricted to allowlisted endpoints
- Secrets never passed as plain-text env vars (use secrets manager references)

**Design for it now:** The trading instance boundary is already clean — no shared mutable state between instances, no direct memory access across them. The agent→trading-instance interface is a message contract (decisions in, execution results out). Whether the agent lives in-process or in a remote container is a deployment detail, not an architecture change. The old project's `BotManager` interface pattern (Docker and ECS implementations behind one interface) validates this approach.

---

## 11. API Layer

### Q11.1: Framework?

Fastify. Built-in schema validation (Zod integration), Pino logging, better TypeScript support, 2–3x throughput over Express.

### Q11.2: Day-1 API scope?

Operator control plane only:
- Trading instance CRUD (create, start, stop, configure)
- Venue account / credential management
- Portfolio and position read views
- Journal / event query
- Health and status endpoints

**Deferred:** User auth (beyond operator token), billing, config marketplace, agents, skills, datasets, broad analytics dashboards, Telegram bot, frontend WebSocket push.

### Q11.3: WebSocket?

Not in v1 scope. The operator observes via structured logs and journal queries. WebSocket push to a frontend comes with the frontend itself — both are deferred.

---

## 12. Frontend

**Deferred.** The engine proves itself with CLI/API observation and structured logs before any frontend work begins. The old React frontend can be ported later when the product surface widens.

---

## 13. Secrets & Credentials

### Q13.1: Encryption scheme?

AES-256-GCM (Node.js `crypto` module), envelope encryption per credential, master key from environment variable. Graduate to AWS KMS / Vault at scale.

### Q13.2: Credential types?

Two distinct storage models:
- **Wallets** (on-chain signing keys): `{ id, userId, chain, publicKey, encryptedPrivateKey }`
- **Venue credentials** (exchange API keys): `{ id, userId, venueId, encryptedApiKey, encryptedSecret, encryptedPassphrase, scopes, createdAt }`

Separate tables because they have different lifecycles, rotation policies, and scope semantics.

### Q13.3: Audit?

Every decrypt, use, and rotate action produces a structured audit event in the journal.

---

## 14. Execution Modes

Four modes, same engine code with different injected dependencies:

| Mode | Market Data | Orders | Money at Risk | Clock |
|------|------------|--------|---------------|-------|
| **Backtest** | Historical (replayed) | Simulated fills | None | Simulated |
| **Paper** | Live prices (fetched) | Simulated fills | None | Real |
| **Shadow** | Live (real quotes/orderbook) | Simulated fills (realistic routing) | None | Real |
| **Live** | Live (real streams) | Real orders | Yes | Real |

The code path is identical up to the side-effect boundary. Backtesting injects `SimulatedClock` + `HistoricalDataFeed` + `PaperExecutor`. Shadow injects real market data but simulates fills.

### Q14.1: Shadow mode scope (v1)

Shadow mode's v1 purpose is to **validate strategy decisions and routing against real market conditions**, not to produce high-fidelity fill simulation that can gate live capital allocation by itself.

**v1 shadow fills:**
- **Market orders (orderbook venues):** Immediate fill at best bid/ask from the live orderbook snapshot. No latency modeling.
- **Limit orders (orderbook venues):** Heuristic fill — fill if the venue's trade stream shows a print at or through the limit price. No queue-position simulation, no cancel/replace timing model.
- **Swaps:** Fill at the quoted output amount from a real `quote()` call (same as the old shadow executor).

**Explicitly deferred (phase 3+):**
- Queue-position simulation for resting limit orders
- Pessimistic fill modeling (partial fills, latency, adverse selection)
- Detailed book capture for replay

Shadow mode in v1 answers: "did the strategy make reasonable decisions given real market state?" It does not answer: "would this strategy's limit orders have been filled at this exact price?" That distinction must be documented so shadow results are not over-trusted when deciding to go live.

---

## 15. Testing & Backtesting

### Q15.1: Backtest ↔ live parity?

The backtest engine injects `SimulatedClock`, `HistoricalDataFeed`, and `PaperExecutor` into the **same engine code** that runs live. No separate backtest loop. This eliminates divergence bugs that plague the old project's separate `packages/backtesting/src/engine.ts`.

### Q15.2: Historical data sources?

1. Recorded live data (data recorder persists candles/ticks to Postgres during live operation)
2. External imports (CSV, venue API historical endpoints)

### Q15.3: LLM strategy backtesting?

Traditional replay alone is insufficient for discretionary LLM behavior. Use replayed contexts for regression tests (given this market state, does the model produce a reasonable decision?). Pin model versions. Compare decisions across model versions on the same context corpus.

---

## 16. Monorepo Structure

```
packages/
  domain/          ← port interfaces, value objects, enums, config schemas. Deps: zod + decimal.js only.
  engine/          ← execution lifecycle, risk gate, reconciliation, routing/plan layer
  venues/          ← ccxt wrapper, DEX SDKs, chain adapters (viem, web3.js)
  strategy/        ← strategy engines (mechanical, llm, hybrid), indicators

apps/
  api/             ← Fastify HTTP server (operator control plane)
  worker/          ← BullMQ worker (trading instance runtime)
```

**Deferred packages (not scaffolded until needed):**
- `packages/market-data/` — when strategies need shared data providers
- `packages/backtesting/` — phase 3 (after reconciliation + shadow + second venue)
- `apps/web/` — phase 5 (product surface)

**No `packages/shared`.** If a concern doesn't belong to a named owner, it's either:
- A domain type → `packages/domain`
- Infrastructure (logging, ID generation, config loading) → inline in the app that uses it, or `packages/infra` if truly cross-cutting

**No `apps/frontend` in v1.** Deferred until the engine is validated.

### Q16.1: Why `venues` not `exchange`?

"Exchange" implies CEX only. "Venues" covers orderbook exchanges, swap aggregators, and future venue types.

### Q16.2: Agent code location?

Deferred. When agents are introduced, they live in `apps/worker/src/agents/` as a runtime concern, not a shared package. This avoids circular dependency with engine.

---

## 17. Event System

### Q17.1: Architecture?

In-process `EventBus` with typed events for local transport within a worker. Redis pub/sub for cross-process events (worker → API, or worker → worker). The old project's `BotScopedRedisTransport` pattern extends naturally.

### Q17.2: Day-1 events?

- `decision:produced` — strategy output (for journal)
- `order:state_changed` — lifecycle transitions
- `fill:recorded` — immutable fill
- `position:updated` — aggregated position change
- `reconciliation:completed` — match or drift
- `risk:rejected` — gate blocked a decision
- `instance:started`, `instance:stopped`, `instance:heartbeat`

---

## 18. Observability

Every decision, validation rejection, execution attempt, order state change, fill, balance change, reconciliation event, and credential access is observable via:
1. Structured JSON logs (Pino) — immediate, queryable
2. Append-only journal table in Postgres — durable, replayable
3. OpenTelemetry-ready instrumentation points — graduate to distributed tracing when needed

Observability exists **before** any dashboard or frontend. The journal is how you explain losses, diagnose venue drift, and replay behavior.

---

## 19. Deployment

Docker Compose for local dev (API + worker + Postgres + Redis in one compose file). Production target deferred — the architecture runs on Railway, Render, Fly.io, or ECS without structural changes.

---

## 20. Build Phases

### Phase 1: Engine Core (validate one venue, paper mode)
1. Scaffold monorepo (`packages/domain`, `packages/engine`, `packages/venues`, `packages/strategy`)
2. Define domain types and day-1 schema (Drizzle migrations)
3. Implement one venue adapter (Hyperliquid via ccxt or Jupiter — whichever matches first strategy)
4. Implement execution lifecycle, risk gate, and paper executor
5. Implement append-only journal and structured logging
6. Implement one strategy engine (mechanical or LLM) producing target-state decisions
7. Wire into `apps/worker` as a long-lived actor with BullMQ lifecycle
8. Build thin operator API (`apps/api`) — instance CRUD, portfolio reads, journal queries

**Exit criterion:** Can run a strategy in paper mode on one venue, observe all events in the journal, and query positions/P&L via API.

### Phase 2: Reconciliation + Shadow + Second Venue
1. Add reconciliation module (periodic venue state comparison)
2. Add shadow executor (real quotes, simulated fills)
3. Add second venue type (swap if first was orderbook, or vice versa)
4. Validate that the unified execution lifecycle works across both venue types

**Exit criterion:** Shadow mode produces realistic fill simulation. Reconciliation detects injected drift.

### Phase 3: Backtesting + LLM Validation
1. Implement `packages/backtesting` (simulated clock + historical data feed + same engine code)
2. Record live market data for replay corpus
3. Run LLM strategy through shadow mode, validate decisions against mechanical baseline
4. Implement context replay for LLM regression testing

**Exit criterion:** Can backtest a strategy and get results comparable to shadow/paper runs.

### Phase 4: Live Rollout
1. Implement live executor (real orders on one venue)
2. Small capital allocation, manual monitoring
3. Validate reconciliation catches real-world drift (funding, fees, slippage)
4. Credential rotation and audit trail verification

**Exit criterion:** Running profitably (or at least safely) with real capital on one venue.

### Phase 5: Product Surface (deferred)
- Broad auth (multi-user, OAuth, plans)
- Agents and autonomous tool use
- Frontend / dashboard
- Billing
- Additional venues and chains
- Telegram / alerting integrations

---

## 21. Conventions

### §21.1: Result type at package boundaries

Every public function exported from a package returns a `Result` — never throws.

```typescript
type Result<T, E = DomainError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

interface DomainError {
  code: string;       // dot-namespaced, e.g. "venue.timeout"
  message: string;    // human-readable description
  context?: Record<string, unknown>;  // optional structured metadata
}
```

**Error code convention:** `<package>.<error_name>` — two segments minimum, lowercase, underscores within segments. Sub-grouping allowed: `venue.hyperliquid.auth_expired`.

Examples:
- `venue.timeout`
- `venue.rate_limited`
- `venue.insufficient_balance`
- `engine.risk_breach`
- `engine.plan_failed`
- `engine.reconciliation_drift`

**Rules:**
1. Package public APIs return `Result<T, E>` — never throw.
2. Internal implementation may throw freely — caught and mapped to a `DomainError` at the boundary.
3. Infrastructure exceptions (DB, Redis, venue SDK) are caught at the boundary and mapped to a domain error.
4. Programmer bugs (invariant violations) throw/crash — never silenced into a Result.
5. Each package defines its own error code enum (e.g. `VenueErrorCode`, `EngineErrorCode`).
6. Codes are i18n-ready: `venue.timeout` maps directly to a translation key (`errors.venue.timeout`).

### §21.2: Plugin boundaries

Plugin interfaces (multiple implementations expected) exist only for:
- **Venues** — `OrderbookVenuePort` and `SwapVenuePort` (per §2.3, no shared parent)
- **Strategies** — `Strategy` interface (mechanical, LLM, hybrid)

Everything else (risk gate, reconciliation, execution lifecycle, plan/routing) has one implementation. Don't add an interface until a second implementation is concretely planned.

### §21.3: `packages/domain` scope

`domain` contains:
- `Result<T, E>` and `DomainError`
- Port interfaces: `OrderbookVenuePort`, `SwapVenuePort`, `MarketDataPort`, `Strategy`
- Value objects: `Price`, `Quantity`, `OrderId`, `Instrument`, `BalanceSnapshot`
- Enums: `OrderSide`, `OrderType`, `ExecutionMode`, `VenueType`
- Config schemas (Zod)

`domain` does NOT contain:
- `ExecutionEngine`, `RiskGate`, `Reconciler`, `PlanRouter` — these are application-layer orchestration owned by `engine`
- Any runtime logic, I/O, or service code

**Dependencies:** `zod` + `decimal.js` only. Both are small, stable, zero-transitive-dependency libraries that model domain fundamentals (validation and money). Money/price value objects are domain concepts — making them strings parsed elsewhere defeats the purpose.

### §21.4: Configuration management

Two config layers with different lifecycles — never mixed into one resolution chain.

**Operator config (deploy-time):**
- Lives in `config/default.yaml` (with inline comments as documentation) + optional `config/{NODE_ENV}.yaml` overrides
- Environment variables override specific values (e.g. `DATABASE_URL` → `database.url`)
- Loaded once at process startup, Zod-validated (fail fast)
- Resolution: `default.yaml` → env-specific YAML → environment variables

**User/instance config (runtime):**
- Stored in Postgres (`trading_instances.config` JSONB or related table)
- Set via API, validated with Zod at write time (reject before it reaches the engine)
- Read by trading instance at startup and on config-change event (Redis pub/sub)

**Principles:**
1. No magic numbers in business logic — any threshold, limit, interval, or policy belongs in config.
2. Sensible defaults for everything — Zod `.default()` collapses schema + defaults + validation into one declaration.
3. Access config through one entry point (`getConfig()`) — never read `process.env` outside the config loader.
4. Group related config under a namespace (`venues.hyperliquid.rateLimitPerSec`, not `hyperliquidRateLimit`).
5. Descriptive names with units: `timeoutMs`, `cacheTtlMs`, `maxCallsPerMinute`.
6. `config/default.yaml` is the self-documenting reference — no separate example file needed.
7. Agent containers never receive operator config blobs — they get only what they need via the message contract. Secrets are never plain-text env vars.

See [docs/best-practices/configuration.md](../../../best-practices/configuration.md) for full guidelines.

---

## 22. Resolved Dependencies

| Decision | Resolution |
|----------|-----------|
| State owner | Portfolio + venue account (not bot) |
| Venue account exclusivity | One trading instance per venue account, no exceptions |
| Execution model | Uniform lifecycle, swap fast-paths through it |
| BullMQ role | Lifecycle coordinator, not tick scheduler |
| Package boundaries | Named for ownership; no `shared` dumping ground |
| Market data in engine | Engine needs only reference mark + venue state; discovery is strategy-specific |
| Valuation policy | Mid-price (orderbook) or oracle/last-fill (swap); never executable quote as standing mark |
| Connection sharing | Public streams shared; private streams exclusive to owning instance |
| Shadow mode (v1) | Validates decisions, not fill quality; no queue simulation |
| Crash rehydration | All durable state in Postgres; cold-start on any worker; reconcile before resuming |
| Risk vs. AI | Hard limits always enforced; AI gets advisory guidance only |
| Day-1 scope | Engine + one venue + paper + journal; not a full product |
| First venue | Matches first live strategy; Hyperliquid recommended for perps |

---

## Backlog (Future Phases)

Risk & execution enhancements for Phase 2+:

- [ ] `riskPerTradePct` — position sizing as function of risk budget (Kelly-lite). Requires stop distance from strategy.
- [ ] `maxPriceDeviationMultiple` — data sanity guard at venue adapter layer; reject absurd price feeds before they reach the engine.
- [ ] Per-position SL/TP enforcement in `TradingActor` scan loop — strategy emits close decisions when SL/TP conditions hit.
- [ ] Trailing stop / ratcheting exit mechanics — advanced exit logic owned by the strategy layer.
- [ ] Dynamic stop placement (ATR-based, swing-based) — strategy provides stop distance, risk gate uses it for sizing.
| Actors | Bot (phase 1, in-process), Agent (phase 2, container-isolated), Manual user (phase 3, stateless API) |
| Error handling | Result type at package boundaries; dot-namespaced codes (`<package>.<error_name>`) |
| Configuration | Two layers: operator YAML (deploy-time) + user JSONB in Postgres (runtime); never mixed |
| Venue port split | `OrderbookVenuePort` + `SwapVenuePort`; no shared parent (§2.3) |
| Domain package deps | `zod` + `decimal.js` only; no runtime logic, no application-layer orchestration |
| Plugin scope | Venues and strategies only; everything else is direct implementation |