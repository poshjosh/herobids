# Phase 1: Engine Core

**Goal:** Run a strategy in paper mode on one venue, observe all events in the journal, and query positions/P&L via API.

**Reference:** [003-design-decisions.md §20](003-design-decisions.md#20-build-phases)

---

## 1. Scaffold Monorepo

- [ ] Init pnpm workspace (`pnpm-workspace.yaml`)
- [ ] Create `packages/domain/` — `package.json`, `tsconfig.json`, `src/index.ts`
- [ ] Create `packages/engine/` — same structure
- [ ] Create `packages/venues/` — same structure
- [ ] Create `packages/strategy/` — same structure
- [ ] Create `apps/api/` — Fastify skeleton
- [ ] Create `apps/worker/` — BullMQ skeleton
- [ ] Root `tsconfig.json` with strict mode, path aliases
- [ ] Root `vitest.config.ts` — one passing test to prove toolchain works
- [ ] Docker Compose file (Postgres + Redis for local dev)
- [ ] `.env.example` with required env vars
- [ ] `config/default.yaml` with initial operator config

## 2. Domain Types

- [ ] `Result<T, E>` and `DomainError` type
- [ ] Value objects: `OrderId` (UUIDv7), `Price`, `Quantity` (decimal.js wrappers), `Instrument`
- [ ] Enums: `OrderSide`, `OrderType`, `OrderStatus`, `ExecutionMode`, `VenueType`
- [ ] Port interfaces: `OrderbookVenuePort`, `SwapVenuePort`
- [ ] Port interface: `Strategy` (produces `Decision`)
- [ ] `Decision` type (target exposure: direction + size + instrument)
- [ ] Config schemas (Zod): `AppConfigSchema`, `TradingInstanceConfigSchema`

## 3. Schema (Drizzle Migrations)

- [ ] `instruments` table
- [ ] `venue_accounts` table
- [ ] `credentials` table (encrypted)
- [ ] `portfolios` table
- [ ] `trading_instances` table (with config JSONB)
- [ ] `decisions` table (append-only, context hash for replay)
- [ ] `execution_plans` table
- [ ] `orders` table (state machine)
- [ ] `fills` table (immutable)
- [ ] `positions` table (derived from fills)
- [ ] `balance_snapshots` table
- [ ] `journal_events` table (append-only audit log)
- [ ] First migration runs clean on empty DB

## 4. First Venue Adapter

- [ ] Hyperliquid adapter implementing `OrderbookVenuePort` (ccxt)
- [ ] Authentication / credential loading
- [ ] `submitOrder`, `cancelOrder`, `fetchPositions`, `fetchBalances`
- [ ] Basic token-bucket rate limiter (in-memory, per-adapter)
- [ ] Integration test against Hyperliquid testnet/demo

## 5. Execution Lifecycle

- [ ] Plan/routing layer: `Decision` → `ExecutionPlan` (maps intent to venue + order params)
- [ ] Order state machine (pending → open → partial → filled / cancelled / rejected)
- [ ] Paper executor (simulates fills at current market price, no real orders)
- [ ] Fill recording (writes to `fills` + updates `positions`)

## 6. Risk Gate

- [ ] Pre-execution risk check (max position size, max drawdown, max open positions)
- [ ] Hard rejection (returns `Result` error, blocks execution)
- [ ] Risk event logging to journal

## 7. Journal & Observability

- [ ] Append-only journal: every decision, plan, order, fill, risk event
- [ ] Pino structured logging (JSON, correlation IDs)
- [ ] Basic health endpoint (`/health`)

## 8. First Strategy

- [ ] One mechanical strategy (e.g. momentum or mean-reversion) implementing `Strategy`
- [ ] Produces `Decision` objects from market data input
- [ ] Configurable parameters via `trading_instances.config`

## 9. Worker Runtime

- [ ] Trading instance as long-lived leased actor in BullMQ worker
- [ ] Scan loop on internal timer (not BullMQ repeated jobs)
- [ ] Lifecycle: start, stop, restart via BullMQ jobs
- [ ] Heartbeat + lease recovery on worker death
- [ ] Graceful shutdown (drain in-flight, release lease)

## 10. Operator API

- [ ] Trading instance CRUD (create, start, stop, configure)
- [ ] Venue account / credential management endpoints
- [ ] Portfolio and position read views
- [ ] Journal / event query endpoint
- [ ] Zod request validation + typed responses

---

## Exit Criteria

- [ ] Can create a trading instance via API
- [ ] Instance runs a strategy in paper mode on Hyperliquid (demo)
- [ ] All decisions, plans, orders, and fills appear in the journal
- [ ] Positions and P&L queryable via API
- [ ] Worker crash → BullMQ reassigns lease → instance resumes on another worker

---

## Backlog (Phase 1 scope — deferred but near-term)

Risk gate enhancements to add before going live:

- [x] `maxPositionSizePct` — position limit as % of equity (current `maxPositionSize` is absolute qty; brittle as capital changes)
- [x] `dailyMaxLossPct` — rolling 24h drawdown cap, isolates a bad day from triggering the all-time `maxDrawdown` kill switch
- [x] `stopLossCooldownMs` — minimum wait before re-entering an instrument after a stop-loss exit; prevents revenge-trading loops
