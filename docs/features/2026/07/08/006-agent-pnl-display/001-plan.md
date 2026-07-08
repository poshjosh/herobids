# Plan: Agent PnL Display — Aggregate & Per-Agent

**Status:** In Progress — implementing
**Date:** 2026-07-08
**Prior art:** `apps/api/src/routes/capabilities/trading.ts` (`/state` and `/outcomes` endpoints), `apps/api/src/routes/exports.ts` (`computeReport()`)

---

## Summary

Display aggregate and per-agent realized PnL in the frontend across three
surfaces:

1. **Mission Control homepage** — a "Total Realized PnL" metric card in the
   top summary row.
2. **Exposure page** — an aggregate PnL summary header above the per-bot
   position breakdown.
3. **Agent list (AgentSummaryCard)** — per-agent realized PnL, trade count, and
   win rate on each agent card.

Phase 1 covers realized PnL only. Net profit (PnL minus infra/LLM costs) is
deferred to a future phase.

---

## Motivation

### Current State

Today, PnL is only visible at the per-position or per-trade level:

| Surface | What exists |
|---|---|
| `ExposurePage` | Realized PnL per open position, per bot |
| `InstanceDetailPage` | Realized PnL per position |
| `AgentDetailPage` → `AgentTradesTable` | Realized PnL per closed trade row |

There is **no aggregate PnL anywhere** — no total across all agents, no
per-agent summary card PnL, and no PnL on Mission Control. Users must mentally
summarise PnL from scattered individual positions/trades.

### What the Backend Already Supports

Two endpoints already exist that compute per-agent aggregate PnL:

- `GET /agents/:agentId/capabilities/trading/state` — returns `totalPnl`
  (SUM of `realizedPnl` across agent-direct + agent-owned-bot positions) and
  `openPositionCount`.
- `GET /agents/:agentId/capabilities/trading/outcomes` — returns `totalPnl`,
  `winRate`, `tradeCount`, `feesByCurrency`, and `openPositionCount`.

The `positions` table has `realizedPnl` (numeric), `actorType` (can be
`'agent'`), `actorId`, and an index on `(actorType, actorId)` — so per-agent
aggregation is efficient.

What's missing is:
- A **bulk endpoint** to fetch PnL for all of a user's agents in one call
  (avoiding N+1 on the agent list page).
- An **aggregate total** across all agents for the dashboard/overview.
- **Frontend types, API client methods, and UI** to surface this data.

---

## Architecture Impact

| Layer | Component | Change |
|---|---|---|
| **API** | `agents.ts` routes | Add `GET /agents/performance` — bulk performance (PnL, win rate, trade count) for all user's agents |
| **API** | `dashboard.ts` routes | Extend `GET /dashboard/overview` with `totalRealizedPnl` field |
| **Web** | `api-client.ts` | Add `AgentPerformance` type, `agents.performance()` method, extend `DashboardOverview` |
| **Web** | `MissionControlPage` | Add PnL metric card to summary row |
| **Web** | `ExposurePage` | Add aggregate PnL header |
| **Web** | `AgentSummaryCard` | Add per-agent PnL row |
| **Web** | i18n strings | New keys for PnL labels and formatting |

No changes to domain, engine, worker, or database schema.

---

## Design

### Phase 1 — Backend: Bulk Performance Endpoint

Add `GET /agents/performance` that returns performance metrics for all of the
user's agents in a single query. This endpoint will serve both today's PnL
display and future agent ranking.

```sql
SELECT
  p.actor_id AS agent_id,
  SUM(p.realized_pnl) AS total_pnl,
  COUNT(*) FILTER (WHERE p.closed_at IS NULL) AS open_position_count,
  COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL AND p.realized_pnl > 0)
    AS winning_closed_count,
  COUNT(*) FILTER (WHERE p.closed_at IS NOT NULL) AS closed_count
FROM positions p
WHERE p.actor_type = 'agent'
  AND p.actor_id = ANY($1)  -- user's agent IDs
GROUP BY p.actor_id;
```

For agents that also own bots, include bot-owned positions by joining through
`agent_connections` → `bots`:

```sql
-- Bot-owned positions attributed to the owning agent
SELECT
  ac.agent_id,
  SUM(p.realized_pnl) AS total_pnl,
  ...
FROM positions p
JOIN bots b ON b.id = p.actor_id AND p.actor_type = 'bot'
JOIN agent_connections ac ON ac.connection_id = b.connection_id
WHERE ac.agent_id = ANY($1)
GROUP BY ac.agent_id;
```

Union both result sets and merge by agent ID.

**Response shape:**

```typescript
interface AgentPerformanceResponse {
  performances: Array<{
    agentId: string;
    totalRealizedPnl: string;     // decimal string, e.g. "123.456000"
    openPositionCount: number;
    closedPositionCount: number;
    winningClosedCount: number;   // for win rate display
  }>;
}
```

Agents with no positions return `totalRealizedPnl: "0"`, not omitted — so the
frontend always has a value to display.

**Route placement:** Add to `apps/api/src/routes/agents.ts`, authenticated,
user-scoped (only returns the caller's agents).

### Phase 2 — Backend: Extend Dashboard Overview

Add `totalRealizedPnl` to `GET /dashboard/overview` response. The existing
query already fetches user + bots; add a parallel query that sums
`positions.realizedPnl` where `actorType = 'agent'` and `actorId` is in the
user's agent IDs (plus the bot-owned-via-connections union).

Add to the response `summary` object:

```typescript
summary: {
  totalBots: number;
  runningBots: number;
  totalOpenPositions: number;
  totalRealizedPnl: string;  // NEW
}
```

**File:** `apps/api/src/routes/dashboard.ts`, `GET /dashboard/overview` handler.

### Phase 3 — Frontend: API Client & Types

**New type** (`apps/web/src/lib/api-client.ts`):

```typescript
export interface AgentPerformance {
  agentId: string;
  totalRealizedPnl: string;
  openPositionCount: number;
  closedPositionCount: number;
  winningClosedCount: number;
}
```

**New method** on the `agents` API object:

```typescript
performance: () => request<{ performances: AgentPerformance[] }>('/agents/performance'),
```

**Extend `DashboardOverview`**:

```typescript
export interface DashboardOverview {
  // ... existing fields ...
  summary: {
    totalBots: number;
    runningBots: number;
    totalOpenPositions: number;
    totalRealizedPnl: string;  // NEW
  };
}
```

### Phase 4 — Frontend: Mission Control PnL Card (1a)

**File:** `apps/web/src/features/mission-control/MissionControlPage.tsx`

Add a query for the dashboard overview (already fetched on the Exposure page
but not here — or add a lightweight query). Display a 5th `MetricCard` in the
summary row:

```tsx
{overviewQuery.data && (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '32px' }}>
    <MetricCard label="Active" value={counts.active} total={agents.length} />
    <MetricCard label="Paused" value={counts.paused} />
    <MetricCard label="Unhealthy" value={counts.unhealthy} />
    <MetricCard label="Stopped" value={counts.stopped} />
    <MetricCard label="Total Realized P&L" value={formatPnl(totalPnl)} />
  </div>
)}
```

Extend `MetricCard` to accept an optional `color` prop (green for positive, red
for negative) so PnL stands out.

**i18n keys needed:**
- `missionControl.metric.totalPnl` → "Total Realized P&L"

### Phase 5 — Frontend: Exposure Page PnL Header (1b)

**File:** `apps/web/src/features/exposure/ExposurePage.tsx`

This page already calls `dashboard.overview()`. Once the response includes
`totalRealizedPnl`, add a summary header card above the per-bot positions:

```tsx
{overview && (
  <Card style={{ marginBottom: '24px', padding: '20px 24px' }}>
    <div style={{ display: 'flex', gap: '32px' }}>
      <KV
        label="Total Realized P&L"
        value={
          <span style={{ color: pnlColor, fontWeight: '600', fontSize: '18px' }}>
            {formatPnl(overview.summary.totalRealizedPnl)}
          </span>
        }
      />
      <KV label="Open Positions" value={overview.summary.totalOpenPositions} />
    </div>
  </Card>
)}
```

No new API call needed — reuses the existing `dashboard.overview()` query.

### Phase 6 — Frontend: Per-Agent Performance on AgentSummaryCard (1c)

**File:** `apps/web/src/features/agents/AgentSummaryCard.tsx`

Add a `useQuery` for `agents.performance()` at the `AgentsPage` level (so one
query serves all cards, avoiding N+1). Pass the per-agent performance down as a
prop or look it up via a map.

On each `AgentSummaryCard`, add a compact performance row below the capability
readiness section:

```tsx
{perf && (
  <div style={{ display: 'flex', gap: '16px', fontSize: '13px', color: 'var(--color-text-secondary)' }}>
    <span>
      P&L:{' '}
      <span style={{ color: pnlColor, fontWeight: '500' }}>
        {formatPnl(perf.totalRealizedPnl)}
      </span>
    </span>
    <span>{perf.closedPositionCount} trades</span>
    {perf.winRate !== null && (
      <span>Win: {(perf.winRate * 100).toFixed(0)}%</span>
    )}
  </div>
)}
```

Only show for agents that have the `trading` capability family.

**Alternative (simpler):** Instead of a bulk endpoint, call the existing
`GET /agents/:agentId/capabilities/trading/state` per agent. This is N+1 but
acceptable for the typical user with < 20 agents. The bulk endpoint (Phase 1)
is preferred for correctness and future ranking support.

**File changes in `AgentsPage.tsx`:** Add a `performanceQuery` and pass
results into each `AgentSummaryCard` via a prop or a React context / map lookup.

### Phase 7 — Formatting Helper

Add a shared `formatPnl` helper to `apps/web/src/lib/formatting.ts`:

```typescript
import Decimal from 'decimal.js';

export function formatPnl(pnl: string | number | null | undefined): string {
  if (pnl == null) return '—';
  const d = new Decimal(pnl);
  const sign = d.gte(0) ? '+' : '';
  return `${sign}$${d.toFixed(2)}`;
}

export function pnlColor(pnl: string | number | null | undefined): string {
  if (pnl == null) return 'var(--color-text-muted)';
  const d = new Decimal(pnl);
  if (d.gt(0)) return 'var(--color-success)';
  if (d.lt(0)) return 'var(--color-danger)';
  return 'var(--color-text-secondary)';
}
```

---

## Implementation Order

| Step | What | Files | Depends on | Status |
|---|---|---|---|---|
| 1 | Bulk PnL endpoint | `apps/api/src/routes/agents.ts` | — | DONE |
| 2 | Extend dashboard overview with PnL | `apps/api/src/routes/dashboard.ts` | — | DONE |
| 3 | API client types + methods | `apps/web/src/lib/api-client.ts` | 1, 2 | DONE |
| 4 | `formatPnl` helper | `apps/web/src/lib/formatting.ts` | — | DONE |
| 5 | Mission Control PnL card (1a) | `MissionControlPage.tsx` | 2, 3, 4 | DONE |
| 6 | Exposure page PnL header (1b) | `ExposurePage.tsx` | 2, 3, 4 | DONE |
| 7 | Per-agent PnL on cards (1c) | `AgentsPage.tsx`, `AgentSummaryCard.tsx` | 1, 3, 4 | PENDING |
| 8 | i18n strings | `apps/web/src/app/i18n/` | 5, 6, 7 | PENDING |

Steps 1–4 can be done in parallel. Steps 5–7 are independent of each other and
can be done in any order after 1–4.

---

## Edge Cases & States

| State | Handling |
|---|---|
| No agents exist | PnL card shows `$0.00` (neutral gray) |
| Agent has trading capability but no trades yet | Card shows `P&L: $0.00 | 0 trades` |
| Agent has no trading capability | PnL row omitted from card entirely |
| Mixed sign PnL across agents | Total shows net; individual cards show per-agent |
| Loading | Skeleton/spinner in card positions (reuse `LoadingRows`) |
| Error | Inline `ErrorState` with retry; non-blocking (rest of page renders) |
| Very large PnL values | `toFixed(2)` handles this; no special formatting needed |

---

## What This Does NOT Cover

- **Net profit** (PnL minus infra/LLM costs) — deferred to Billing page in a
  future phase.
- **Unrealized PnL** — requires mark-price data; the positions table does not
  store mark prices. Deferred.
- **PnL charts / time-series** — out of scope for this display-only phase.
- **Admin dashboard PnL** — platform-wide aggregate is a separate feature.

---

## Risks

| Risk | Mitigation |
|---|---|
| Bulk endpoint query is slow with many agents/positions | The `idx_positions_actor` index covers the query; benchmark with realistic data volumes. Add a materialized cache if needed (unlikely at current scale). |
| Bot-owned position attribution via `agent_connections` is complex | The existing `selectAgentTradingAssignmentRows` helper in `trading.ts` already solves this. Reuse it. |
| `AgentSummaryCard` already has multiple data dependencies | Add PnL as an optional prop — card renders fine without it. |

---

## Outstanding Issues

### [Step 1] Bulk PnL endpoint

- **MEDIUM** — `totalRealizedPnl` returns a string (`toFixed(6)`) while other fields return numbers. API response type inconsistency. Consider either converting to `Number()` or using strings for all monetary fields consistently.
- **MEDIUM** — `Number()` on `sum(realizedPnl)` loses PostgreSQL `numeric` precision to IEEE 754 double. Acceptable for display-only endpoint but would be problematic if used for settlement. Document this is display-only.
- **LOW** — Duplicate merge construction logic between `directResults` and `botOwnedResults` loops. Extract a helper for DRY.
- **LOW** — Missing response type annotation on the route handler for consistency with other endpoints in the file.

### [Step 2] Dashboard overview PnL

- **LOW** — Missing `connectionId` null guard comment in Part 2 bot join condition; `bots.connectionId` is `.notNull()` per schema so no runtime risk.
- **LOW** — Frontend `DashboardOverview` type not yet extended (planned for Step 3).
- **LOW** — `.toFixed(6)` is a duplicated magic number across `dashboard.ts`, `agents.ts`, `trading.ts`. Could extract to shared constant.
- **LOW** — Comment could clarify why no per-agent grouping (dashboard is aggregate-only; per-agent lives at `GET /agents/performance`).

### [Step 3] API client types + methods

- **MEDIUM** — Plan doc Phase 6 sample UI code references `perf.winRate` but the `AgentPerformance` type exposes `winningClosedCount` (raw count). Step 7 implementer must compute rate as `winningClosedCount / closedPositionCount`.
- **LOW** — Missing JSDoc on `AgentPerformance` interface for field documentation.
- **LOW** — No test coverage for new types/methods (acceptable for type-only change).

### [Step 4] formatPnl helper

- **MEDIUM** (fixed) — Negative dollar format was `$-50.00`, now corrected to `-$50.00` (standard).
- **MEDIUM** (fixed) — Zero PnL color was `var(--color-text-secondary)`, now aligned with existing `AgentTradesTable` convention (`var(--color-text)`).
- **LOW** — `formatPnl(0)` shows `+$0.00` with plus prefix; existing `AgentTradesTable` omits `+` for zero. Minor inconsistency.
- **LOW** — No guard against invalid Decimal input (throws on empty string, NaN). Backend always returns valid decimal strings, so low risk.
- **LOW** — Missing trailing newline at end of file.
- **LOW** — No JSDoc on new functions.
- **LOW** — `AgentTradesTable` duplicates inline PnL logic; should eventually use shared helpers.

### [Step 5] Mission Control PnL card

- **MEDIUM** — `pnlColor` returns `'var(--color-text)'` for zero PnL, but this CSS variable is not defined. Should use `'var(--color-text-primary)'` or omit the color prop for zero to let the MetricCard default handle it.
- **MEDIUM** — `overviewQuery` error state is silently swallowed — PnL card shows `—` with no error indicator or retry affordance. Inconsistent with the activity section's explicit LoadingRows/ErrorState pattern.
- **LOW** — `overviewQuery` never invalidates on trading events — PnL card won't refresh when agents make trades. Add invalidation or refetchInterval.
- **LOW** — `AgentTradesTable.tsx` has pre-existing duplicate PnL color logic not using the new shared helper.

### [Step 6] Exposure page PnL header

- **LOW** — Nested `<span>` redundancy: `KV` wraps value in a styled `<span>`, and the PnL value is itself a styled `<span>`. Visual output correct but DOM unnecessarily nested.
- **LOW** — `pnlColor` zero-value return differs from plan spec (`var(--color-text)` vs plan's `var(--color-text-secondary)`). Already consistent across Mission Control and Exposure, but diverges from original plan.

### [Step 7] Per-agent PnL on AgentSummaryCard

- **MEDIUM** — Hardcoded English strings ("P&L:", "trades", "Win:") in the PnL row — needs i18n keys (addressed in pending Step 8).
- **MEDIUM** — Silent degradation on `performanceQuery` failure: cards render without PnL row with no user indication. Plan gap — consider adding inline "PnL unavailable" indicator.
- **LOW** — Win rate uses `toFixed(0)` (whole-number percent). For small trade counts, consider `toFixed(1)`.
- **LOW** — `performanceQuery` variable unused except for `.data` (could be inlined).
- **LOW** — PnL row renders for all agents, not just trading-capability agents. Defensive concern — practically harmless since non-trading agents won't have performance data.
