# Library Stack for Greenfield Trading Platform

## The Backbone

```
ccxt + official DEX SDKs + viem + @solana/web3.js + BullMQ + Fastify + Zod + Drizzle + decimal.js
```

---

## Exchange Connectivity

### Orderbook Venues (CEX + Hyperliquid/dYdX)

**ccxt** (v4.x, MIT, 107 exchanges)

Use for: REST order placement, account queries, position fetching, balance checks.

ccxt Pro (bundled, free) for: WebSocket streams — order updates, position changes, ticker data.

Wrap it once. Never let `ccxt.Order` or `ccxt.Position` types escape `packages/exchange`. The rest of the system sees your canonical types only.

```ts
// packages/exchange/src/orderbook-venue.ts
import ccxt from 'ccxt';

export interface OrderbookVenue {
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(id: string, symbol: string): Promise<void>;
  modifyOrder(id: string, changes: OrderModification): Promise<OrderResult>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<Balance>;
  watchPositions(cb: (p: Position[]) => void): Unsubscribe;
  watchOrders(cb: (o: Order[]) => void): Unsubscribe;
  watchTicker(symbol: string, cb: (t: Ticker) => void): Unsubscribe;
}
```

**When to bypass ccxt and go direct:**
- If a venue's private WebSocket stream quality matters (e.g., Binance's user data stream is better consumed raw than through ccxt Pro's abstraction)
- Use `ws` (npm) for raw WebSocket in those rare cases

### Swap/AMM Venues (Jupiter, 1inch, LiFi)

| Venue | Library | Notes |
|-------|---------|-------|
| Jupiter (Solana) | `@jup-ag/api` | Official SDK. Routing, slippage, priority fees handled. |
| 1inch (EVM) | `@1inch/sdk` or direct REST | Simpler than Jupiter. Aggregator routing built in. |
| LI.FI (cross-chain) | `@lifi/sdk` | Only if cross-chain routing is a first-class requirement. Don't add speculatively. |

These are fundamentally simpler than orderbook venues. A swap either succeeds or fails atomically. No partial fills, no order lifecycle, no position state to reconcile.

```ts
// packages/exchange/src/swap-venue.ts
export interface SwapVenue {
  quote(params: SwapQuoteRequest): Promise<SwapQuote>;
  execute(quote: SwapQuote, signer: WalletSigner): Promise<SwapResult>;
  supportedTokens(): Promise<TokenInfo[]>;
}
```

---

## Chain Plumbing

| Chain | Library | Purpose |
|-------|---------|---------|
| EVM (Base, Arbitrum, Ethereum) | `viem` | Transaction construction, signing, ABI encoding, contract reads |
| Solana | `@solana/web3.js` + `@solana/spl-token` | Transaction building, token accounts, program interaction |

**Why viem over ethers.js:** Smaller bundle, better TypeScript types, tree-shakeable, actively maintained, and the ecosystem is moving toward it.

**Why not abstract chains behind one interface:** EVM and Solana are too different at the transaction level. A shared `ChainClient` interface would be so thin it's useless, or so thick it reimplements both SDKs. Let them be separate — the `SwapVenue` interface above is where unification happens (one layer up).

---

## Trading Math

**`decimal.js`** for all financial calculations: position sizing, P&L, fee computation, price comparison.

**`bigint`** (native) for atomic units: lamports, wei, token amounts in smallest denomination.

This is non-negotiable. JavaScript `number` uses IEEE 754 double-precision floats:
```
0.1 + 0.2 = 0.30000000000000004
1.005 * 100 = 100.49999999999999
```

In a trading system, this produces:
- Incorrect position sizes that fail exchange validation
- P&L drift that compounds over thousands of trades
- Fee calculations that don't match exchange records
- Reconciliation failures that look like bugs but are just float math

Rule: **`number` is only for display and non-financial logic (timestamps, counters, percentages for UI).** All money math goes through `Decimal` or `bigint`.

---

## Control Plane

| Concern | Library | Why this one |
|---------|---------|--------------|
| HTTP API | `fastify` | Faster than Express, native schema validation, TypeScript-first, Pino logging built in |
| Validation | `zod` | Runtime + compile-time type safety, composes with Fastify's schema system |
| Database | `drizzle-orm` + `pg` | Type-safe queries, no heavy ORM abstraction, raw SQL escape hatch, migrations via drizzle-kit |
| Cache/state | `ioredis` | Redis client — used for ephemeral state, locks, pub/sub |
| Queues | `bullmq` | Job queues on Redis — bot lifecycle, scheduled tasks, retries with backoff |
| Logging | `pino` | Structured JSON logs, comes free with Fastify |
| Tracing | `@opentelemetry/*` | Distributed tracing — not week-1, but wire it in early so you're not retrofitting |

---

## Bot Orchestration

**BullMQ** handles:
- Bot start/stop as jobs (durable, survives API server restarts)
- Scheduled strategy evaluation (repeatable jobs)
- Retry with exponential backoff on transient failures
- Concurrency control (limit simultaneous executions per worker)
- Job progress tracking visible to the API/UI

**Worker topology:**
- Pool workers by exchange connection
- All bots on Kraken share one authenticated WebSocket — orders/positions routed by symbol
- Horizontal scaling: add worker processes, BullMQ distributes jobs

---

## AI / Strategy

| Concern | Library | Notes |
|---------|---------|-------|
| LLM calls | Direct HTTP to provider APIs (OpenAI, Anthropic, etc.) | No framework in the execution path |
| Structured output | `zod` + provider's structured output mode | Type-safe decisions |
| Indicators | `technicalindicators` (npm) or raw computation | Pure functions, no framework |
| Embeddings/RAG | Only if needed for market analysis context | Not a day-1 requirement |

**Explicitly avoid LangChain / LlamaIndex in the execution path.** These frameworks add latency, abstraction, and failure modes. An LLM call in a trading bot is: construct prompt → call API → parse structured response. That's 20 lines of code, not a framework.

AI produces a `StrategyDecision`. The engine executes it. The AI never touches exchange APIs directly.

---

## Secrets & Credentials

| Concern | Approach |
|---------|----------|
| Encryption at rest | `aes-256-gcm` (Node.js `crypto` module) — envelope encryption per credential |
| Master key | Environment variable → graduate to AWS KMS / Vault at scale |
| Key rotation | Atomic: encrypt with new key, store new ciphertext, invalidate old |
| Audit | Every decrypt/use/rotate produces a structured log event |

No additional library needed for the first version. Node's `crypto` module handles AES-GCM natively.

---

## Testing

| Concern | Library |
|---------|---------|
| Unit/integration tests | `vitest` |
| API testing | `supertest` or Fastify's built-in `inject()` |
| Mocking | `vitest` built-in mocks |
| Exchange simulation | Custom test harness wrapping your `OrderbookVenue` interface |

---

## What We Explicitly Don't Use

| Don't use | Why |
|-----------|-----|
| Freqtrade | GPL-3.0, Python, single-bot-per-instance, rigid strategy interface |
| ethers.js | Superseded by viem for new projects |
| LangChain | Too heavy for the execution path; fine for offline analysis tooling |
| Kafka | Overkill early; Redis Streams or BullMQ events are sufficient until proven otherwise |
| GraphQL | REST + WebSocket is simpler for this domain; no complex client-side query needs |
| Prisma | Query overhead, opaque query engine binary, less control than Drizzle |

---

## Dependency Philosophy

**Own:** domain model, risk engine, reconciliation, orchestration, position intent resolution, execution state machine, audit trail.

**Depend on:** venue connectivity (ccxt, DEX SDKs), chain signing (viem, web3.js), infrastructure (BullMQ, Fastify, Drizzle), math (decimal.js).

**The test:** if a library dictates your data model or control flow, you've given away too much. Every dependency must be replaceable by swapping one adapter file — never by rewriting the system.
