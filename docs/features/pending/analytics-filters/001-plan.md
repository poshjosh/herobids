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
`groupBy='symbol'`, event counts (`eventCount`, `decisionCount`, `fillCount`) should
be derived from fills joined to positions via `positionId`, or omitted and replaced
with fill count from the positions side. The simplest correct approach: when
`groupBy='symbol'`, aggregate only from `posRows` (P&L and fill count) and skip
the journal event loop.

### Checklist

- [ ] Add `symbols` to `AnalyticsQuerySchema` and `AnalyticsBodySchema`
  ```typescript
  symbols: z.union([z.string(), z.array(z.string())]).optional().transform(...)
  ```
- [ ] Filter `posRows` by `p.symbol` when `query.symbols` is set
- [ ] Add `'symbol'` to the `groupBy` enum in both schemas
- [ ] Add `symbol` case to `groupKey()` function — returns `p.symbol`
- [ ] When `groupBy='symbol'`, skip the journal events loop (events lack symbol) or
  populate fill counts from `posRows` only
- [ ] Add unit tests: filter by single symbol, filter by multiple symbols,
  groupBy='symbol' returns one group per symbol
- [ ] `pnpm lint` passes

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

- [ ] Add `exitReason: text('exit_reason')` to `positions` schema
- [ ] Generate and apply migration
- [ ] Identify write path(s) where positions are closed — stamp `exitReason` from
  decision `metadata.reason` (check `packages/engine/src/instrument-executor.ts`
  and position tracker)
- [ ] Add `exitReasons` to `AnalyticsQuerySchema` and `AnalyticsBodySchema`
- [ ] Filter `posRows` by `p.exitReason` when `query.exitReasons` is set
- [ ] Add `'exitReason'` to the `groupBy` enum
- [ ] Add `exitReason` case to `groupKey()` — returns `p.exitReason ?? 'unknown'`
- [ ] Add unit tests: filter by exit reason, groupBy='exitReason' breakdown
- [ ] `pnpm lint` passes

---

## Order of Execution

Step 1 and Step 2 are independent. Step 1 is cheaper (no migration) and can ship
first.

Recommended order: **1 → 2**
