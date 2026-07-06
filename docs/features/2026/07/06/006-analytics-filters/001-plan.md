# Analytics Filters Parity

Add `symbols` and `exitReasons` filter + groupBy options to the analytics API,
matching the capabilities of the aitradingbot reference implementation.

---

## Background

aitradingbot's `AnalyticsQuery` supports filtering and grouping by `tokens` (symbols)
and `exitReasons`. herobids analytics currently only supports `botIds`, `agentIds`,
`sessions`, and `decisionModes` (the last of which is currently broken — see
`bot-config-integrity` Step 6).

These two additions answer the two most important questions a trader or agent asks
when reviewing analytics:
- "Which instruments are making or losing money?"
- "Why are my positions closing, and which exit reasons are profitable?"

---

## Step 1 — `symbols` filter and `symbol` groupBy

**Files:** `apps/api/src/routes/analytics.ts`

`positions.symbol` already exists. This is purely an API/query change — no schema
migration needed.

### Filter behaviour

When `symbols` is provided, restrict `posRows` (and optionally `filteredEvents`) to
those where `position.symbol` is in the set.

```typescript
// In computeAnalytics, after fetching posRows:
const filteredPosRows = query.symbols && query.symbols.length > 0
  ? posRows.filter((p) => query.symbols!.includes(p.symbol))
  : posRows;
```

### groupBy='symbol' behaviour

Add `'symbol'` to the `groupBy` enum. The `groupKey` function returns `position.symbol`
(or the symbol extracted from journal event metadata for the event side of the
aggregation).

Note: journal events do not have a `symbol` column — only positions do. For
`groupBy='symbol'`, event counts (`eventCount`, `decisionCount`, `fillCount`) cannot
be derived from journal events. Positions rows are aggregates, not fill records, so
counting "one position = one fill" would undercount multi-fill entries/exits and
partial closes. The implemented approach: when `groupBy='symbol'`, skip the journal
event loop and leave `eventCount`, `decisionCount`, and `fillCount` at 0. Only
`realizedPnl` is aggregated from positions. A future enhancement could join fills to
positions to derive accurate fill counts per symbol.

### Checklist

- [x] Add `symbols` to `AnalyticsQuerySchema` and `AnalyticsBodySchema`
  ```typescript
  symbols: z.union([z.string(), z.array(z.string())]).optional().transform(...)
  ```
- [x] Filter `posRows` by `p.symbol` when `query.symbols` is set
- [x] Add `'symbol'` to the `groupBy` enum in both schemas
- [x] Add `symbol` case to `groupKey()` function — returns `p.symbol`
- [x] When `groupBy='symbol'`, skip the journal events loop (events lack symbol).
  fillCount stays at 0 — positions are aggregates, not fill records. Real fill
  counts per symbol would require a fill join (future enhancement).
- [x] Add unit tests: filter by single symbol, filter by multiple symbols,
  groupBy='symbol' returns one group per symbol
- [x] `pnpm lint` passes

---

## Step 2 — `exitReasons` filter and `exitReason` groupBy

**Files:** `packages/db/src/schema/positions.ts`, migration, `apps/api/src/routes/analytics.ts`

`positions` does not have an `exitReason` column. Exit reasons are written into
journal event metadata (e.g. `{ reason: 'signal_lost' }`, `{ reason: 'parabolic_move' }`).
Adding a column to `positions` is the correct approach — querying JSON from journal
events at analytics time is slow and fragile.

Known exit reason values (from `mechanical-strategy.ts`):
- `signal_lost` — no signal on re-evaluation, had open position
- `parabolic_move` — last candle moved too fast
- `daily_limit_reached` — hit `maxNewPositionsPerDay`
- `sentiment_suppressed` — post-sentiment confidence below threshold
- `stop_loss` — risk gate forced exit (if implemented)
- `manual` — user/agent forced flat

### Schema change

```typescript
// positions.ts
exitReason: text('exit_reason'),  // nullable — null for open positions or unknown closes
```

Generate migration: `pnpm --filter @herobids/db run generate`

### Write path

When a position closes, stamp `exitReason` from the decision metadata. The position
tracker / executor that writes the close must extract `metadata.reason` from the
closing decision and persist it.

### Filter behaviour

```typescript
const filteredPosRows = query.exitReasons && query.exitReasons.length > 0
  ? posRows.filter((p) => p.exitReason && query.exitReasons!.includes(p.exitReason))
  : posRows;
```

### groupBy='exitReason' behaviour

`groupKey` returns `p.exitReason ?? 'unknown'`. Aggregates P&L by exit reason,
revealing which closure types are profitable (e.g. `signal_lost` positions may have
negative avg P&L if they exit too early).

### Checklist

- [x] Add `exitReason: text('exit_reason')` to `positions` schema
- [x] Generate and apply migration
- [x] Identify write path(s) where positions are closed — stamp `exitReason` from
  decision `metadata.reason` (check `packages/engine/src/instrument-executor.ts`
  and position tracker)
- [x] Add `exitReasons` to `AnalyticsQuerySchema` and `AnalyticsBodySchema`
- [x] Filter `posRows` by `p.exitReason` when `query.exitReasons` is set
- [x] Add `'exitReason'` to the `groupBy` enum
- [x] Add `exitReason` case to `groupKey()` — returns `p.exitReason ?? 'unknown'`
- [x] Add unit tests: filter by exit reason, groupBy='exitReason' breakdown
- [x] `pnpm lint` passes

---

## Order of Execution

Step 1 and Step 2 are independent. Step 1 is cheaper (no migration) and can ship
first.

Recommended order: **1 → 2**

---

## Outstanding Issues

### [Step 1 — symbols] fillCount omitted for symbol/exitReason modes.

`fillCount` is left at 0 (same as `eventCount`/`decisionCount`) when the journal
event loop is skipped. This happens for `groupBy='symbol'`, `groupBy='exitReason'`,
and any query with `symbols` or `exitReasons` filters. A positions row is an
aggregate, not a fill record — counting "one position = one fill" would undercount.
Real fill counts per symbol/exitReason would require a join from positions to fills
(future enhancement).

### [Step 2 — exitReasons] No outstanding issues.

- Reversal closes (e.g. long→short) now correctly stamp `exitReason` on the closed
  row and open a fresh row with `realizedPnl: '0'`, preventing P&L double-counting
  in analytics.
- All checklist items completed. `pnpm lint` and 29 unit tests pass.
- Migration `0034_elite_la_nuit` is generated and registered.
- `exitReason` is stamped from `decision.metadata.reason` in `decision-intake.ts`
  and threaded through `PersistPositionParams` → `UpsertPosition` → `PositionRepository.upsert`.
