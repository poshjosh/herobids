## If I Were Starting From Zero

### The Core Insight First

The biggest architectural mistake in trading platforms is building around *venues*. People think "I need a Kraken module, a Jupiter module, a Binance module." Then strategy logic gets tangled with execution logic, and every new venue means touching strategy code.

Instead, I'd build around **three layers that never touch each other:**

```
Decisions → Desires → Execution
```

- **Decision Layer**: AI/indicators produce "I want to be short 0.5 BTC"
- **Desire Layer**: Translates intent into venue-appropriate action (which venue, what instrument, what order type)
- **Execution Layer**: Handles the mechanics (place order, handle fills, retry, confirm)

---

### The Stack I'd Choose

**Runtime:** Node.js + TypeScript (strict mode)
**Persistence:** PostgreSQL (source of truth) + Redis (state, cache, pub/sub, queues)
**Process orchestration:** BullMQ (job queues for bot lifecycle)
**API:** Fastify (faster than Express, better TypeScript support, schema validation built-in)
**Monorepo:** pnpm workspaces (like you already have)

---

### Package Structure

```
packages/
  exchange/        ← venue connectivity (ccxt + AMM SDKs)
  engine/          ← trading loop, position management, risk
  strategy/        ← indicators, signals, AI decisions
  backtesting/     ← simulation engine
  shared/          ← types, utils

apps/
  api/             ← HTTP server, auth, WebSocket for UI
  worker/          ← bot runtime (spawned per-bot or pooled)
  frontend/        ← web UI
```

---

### Exchange Connectivity: What I'd Actually Use

**For orderbook venues (CEX + Hyperliquid/dYdX):**

I'd use **ccxt**. Full stop. Here's why:

- The 55MB problem is a Docker image problem, not a runtime problem. Your image is already 200MB+ with node_modules. 55MB more is noise.
- The "per-venue SDK" approach (siebly's packages) means maintaining separate adapter code for every exchange. That's fine for 1 venue. At 3+ venues, you're reimplementing ccxt's unification yourself.
- ccxt's types are loose — but you wrap it once and expose your own tight types. You're writing that wrapper regardless of what's inside.
- The "tree-shaking" concern is irrelevant in Node.js server-side code. You're not shipping to a browser.

I'd wrap it:
```ts
// packages/exchange/src/orderbook-client.ts
import ccxt, { Exchange } from 'ccxt';

export interface OrderbookVenue {
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(id: string, symbol: string): Promise<void>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  watchPositions(cb: (p: Position[]) => void): () => void;
  watchOrders(cb: (o: Order[]) => void): () => void;
}

export function createOrderbookVenue(config: VenueConfig): OrderbookVenue {
  const exchange = new ccxt[config.exchangeId]({ ... });
  return { /* implementation */ };
}
```

**For AMM/swap venues (Jupiter, 1inch):**

Separate abstraction entirely:
```ts
export interface SwapVenue {
  quote(params: SwapQuoteRequest): Promise<SwapQuote>;
  execute(quote: SwapQuote, wallet: WalletSigner): Promise<SwapResult>;
}
```

Implementations:
- Jupiter: `@jup-ag/api` (official SDK) — handles routing, slippage, priority fees
- 1inch: `@1inch/sdk` or direct API calls — simpler than Jupiter
- Future: LI.FI or Socket for cross-chain aggregation

These are fundamentally simpler than orderbook venues. A swap either succeeds or fails atomically. No partial fills, no order lifecycle, no position state.

---

### The Trading Engine

This is where the real value lives. Not in exchange connectivity (that's plumbing), but in:

**1. Position Intent Resolution**

The strategy says: "Target position: short 0.5 BTC."
The engine figures out:
- Current position: long 0.2 BTC on-chain (Solana)
- To reach -0.5 BTC: sell 0.2 on-chain + open 0.5 short on Kraken
- OR: open 0.7 short on Kraken (keep spot, hedge with perp)
- Engine chooses based on cost, speed, liquidity rules

This is where intelligence about venue selection lives.

**2. Execution State Machine**

Each order goes through:
```
INTENT → PLACED → PARTIALLY_FILLED → FILLED → CONFIRMED
                → REJECTED (retry?)
                → CANCELLED (by us or exchange)
                → EXPIRED
```

The engine handles retries, partial fills, slippage, timeout. Strategy never sees this complexity.

**3. Reconciliation Layer**

Exchanges lie. They send you a fill, then amend it 30 seconds later. Funding payments arrive out of band. Liquidations happen without your order. The reconciliation layer is the code that:

- Normalizes raw venue responses (different field names, different timestamp formats, different fee structures) into your canonical `Fill`, `Position`, `Balance` types
- Detects discrepancies between local state and exchange state ("I think I have 0.5 BTC but Kraken says 0.48")
- Handles late events: amended fills, retroactive funding, partial liquidations
- Produces reconciliation events that the journal and alerting systems consume

This is not glamorous. It is also where most production trading bugs live. Every exchange has quirks: Kraken uses `txid` arrays, Binance sends cumulative vs. incremental fills, Hyperliquid batches funding into position updates. The reconciliation layer absorbs all of this so the rest of the system sees clean canonical types.

```ts
interface Reconciler {
  ingestFills(raw: RawVenueFill[]): CanonicalFill[];
  ingestPositions(raw: RawVenuePosition[]): PositionDelta[];
  ingestBalances(raw: RawVenueBalance[]): BalanceSnapshot;
  detectDrift(local: Position[], venue: Position[]): DriftEvent[];
}
```

**4. Risk Layer**

Between decision and execution:
- Max position size check
- Max leverage check
- Drawdown circuit breaker
- Correlation limits (not 5 positions in the same token)
- Rate limit on new positions per time window

This is NOT inside the strategy. It's a gate that decisions pass through.

---

### AI / Strategy Layer

I'd keep this embarrassingly simple:

```ts
interface StrategyDecision {
  action: 'go_long' | 'go_short' | 'go_flat' | 'hold';
  symbol: string;
  conviction: number;       // 0-1
  targetSize?: number;      // optional — let risk layer decide
  reasons: string[];
  metadata?: Record<string, unknown>;
}

interface Strategy {
  evaluate(context: MarketContext): Promise<StrategyDecision[]>;
}
```

The LLM strategy is one implementation. A mechanical RSI strategy is another. They produce the same output. The engine doesn't care who made the decision.

For indicators, I'd use **technicalindicators** (npm) or compute them from raw candles. No framework — indicators are pure functions.

---

### Secrets & Credential Management

A multi-user platform stores exchange API keys, wallet private keys, and auth tokens. This is a day-one subsystem, not an afterthought:

- **Encrypted at rest** — envelope encryption (data key per credential, master key in KMS or env)
- **Never logged** — redacted from all structured logs, error messages, and observability pipelines
- **Scoped per user** — one user's credential breach cannot leak another's
- **Rotatable** — API keys can be replaced without downtime; old key invalidated, new key activated atomically
- **Auditable** — every credential access (decrypt, use, rotate) produces an audit event

For a first version: encrypt with `aes-256-gcm`, store ciphertext + nonce + tag in Postgres, master key from env var. Graduate to AWS KMS / Vault when the user count justifies it.

---

### Execution Modes

Four distinct modes, not two:

| Mode | Market Data | Orders | Money at Risk |
|------|-------------|--------|---------------|
| **Backtest** | Historical (CSV/DB) | Simulated fills | None |
| **Paper** | Live | Simulated fills against live prices | None |
| **Shadow** | Live | Real orders computed but NOT sent; logged for comparison | None |
| **Live** | Live | Real orders, real fills | Yes |

**Shadow trading** is distinct from paper trading. Paper trading simulates fills optimistically ("you would have been filled at this price"). Shadow trading runs the *full* execution path — venue selection, order construction, risk checks — and logs what *would* have been sent. This catches bugs that paper trading misses: rate limits, insufficient margin, order size granularity, API auth failures.

Every bot starts in paper → graduates to shadow → then live. The code path is identical; only the final `execute()` call is gated.

---

### Multi-User / Multi-Bot

**Each bot is a job in BullMQ:**
- API server enqueues "start bot" job
- Worker picks it up, runs the trading loop
- Loop: fetch data → evaluate strategy → check risk → execute → sleep → repeat
- "Stop bot" = cancel the job

**Why BullMQ over Docker-per-bot:**
- Faster startup (no container boot)
- Shared memory for market data (one WebSocket connection per exchange, fan out to N bots)
- Easier to manage 1000 bots than 1000 containers
- Can still scale horizontally (multiple worker processes)

Docker-per-bot makes sense when bots are truly isolated (different users, different security boundaries). BullMQ-per-bot makes sense when you're orchestrating many bots in a shared-infrastructure platform.

For a multi-tenant SaaS: **pool workers by exchange connection.** All bots trading on Kraken share one authenticated WebSocket. Position/order events are routed to the correct bot by symbol.

---

### Build vs. Depend

The dividing line is: **own anything that IS the product; depend on anything that ENABLES the product.**

**I'd build myself (this is the product):**
- The canonical domain model: Instrument, Position, Order, Fill, Balance, PortfolioExposure, RiskEvent
- The event model and event bus contracts
- Bot lifecycle, orchestration, and scheduling
- Portfolio-level risk engine and capital allocation
- Reconciliation layer (venue responses → canonical state)
- Position Intent Resolution (target state → execution plan)
- Backtesting, paper trading, and shadow trading harnesses
- Kill-switch and circuit-breaker logic
- Audit trail and observability pipeline

**I'd depend on (plumbing, not product):**
- Exchange connectivity transport: **ccxt** (orderbook), **Jupiter SDK** / **1inch** (AMM)
- WebSocket management and reconnection: **ccxt Pro**
- Queue/orchestration infrastructure: **BullMQ** + Redis
- Database: **PostgreSQL** + **Drizzle ORM**
- Auth: **Clerk** or **Auth.js**
- Indicators: **technicalindicators** npm or raw computation
- Charting: **TradingView** widget or **lightweight-charts**
- Secrets at scale: **AWS KMS** or **HashiCorp Vault** (later)

The rule: if a library dictates your domain model or data flow, you've given away too much. ccxt should be invisible above the `packages/exchange` boundary.

---

### Sequencing (What I'd Build First)

**Week 1-2: Skeleton + Domain Model**
- Monorepo setup, canonical types (Instrument, Position, Order, Fill, Balance)
- packages/exchange with ccxt wrapper
- One venue working (Kraken Futures paper trading)
- Simplest possible strategy (hardcoded "buy BTC if RSI < 30")
- Credential subsystem (encrypted API keys in Postgres)

**Week 3-4: Core Loop + Reconciliation**
- BullMQ worker running bot loop
- Reconciliation layer: venue responses → canonical fills/positions
- API server: create bot, start/stop, view positions
- Add Jupiter (Solana spot) as second venue type
- Paper + shadow trading modes for both paths

**Week 5-6: Risk + Multi-Strategy**
- Risk layer as a gate between decision and execution
- Kill-switch and circuit breakers
- Mechanical multi-strategy support (RSI, MACD, breakout)
- LLM strategy in paper/shadow mode only
- Multiple bots running simultaneously

**Week 7-8: AI Live + UI**
- Validate shadow-mode AI decisions against actual market outcomes
- Graduate AI strategy to live execution (small size, tight risk limits)
- Basic web UI (positions, P&L, bot controls)
- Alerts (Telegram)
- Audit trail and observability pipeline

---

### The Honest Tradeoffs

**What this approach optimizes for:**
- Speed to first working system
- Flexibility to add venues without architectural changes
- Clear separation of concerns
- Leveraging existing open-source work (ccxt, Jupiter SDK)

**What this approach sacrifices:**
- Ultra-low-latency execution (ccxt adds overhead vs. raw API)
- Full control over exchange quirks (ccxt smooths over differences, sometimes incorrectly)
- Minimal bundle size (ccxt is large)
- Offline-first / embedded deployment (assumes server infrastructure)

**The single biggest risk:**
ccxt being a single point of failure for all CEX connectivity. If ccxt has a bug with Kraken's API, you're blocked until they fix it or you patch it. Mitigation: ccxt is MIT-licensed, actively maintained (weekly releases), and you can fork/patch.