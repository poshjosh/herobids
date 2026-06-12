# Agent Trades Table

Add a paginated positions history table to the `AgentDetailPage` showing per-position trade rows (entry price, exit price, hold duration, PnL, mode). The table renders only for agents with trading capability and is powered by a new dedicated backend endpoint that joins positions with fills to derive exit price.

## Goal

Surface trading history to operators in the agent detail UI so they can evaluate agent performance at a glance, without leaving the page.

## Background

The API already exposes `/agents/:agentId/capabilities/trading/activity` (raw fills + journal events) and `/agents/:agentId/capabilities/trading/outcomes` (aggregate stats). Neither provides a per-position view with entry price, exit price, hold duration, and PnL together. The `fills` table has no `positionId` foreign key, so exit price must be derived by finding the most recent fill for the same actor/symbol on or before `closedAt`. The UI already uses `hasTradingCapability` to conditionally show capability panels; the same guard applies here.

## Desired End State

### Backend

`GET /agents/:agentId/capabilities/trading/positions` exists in `apps/api/src/routes/capabilities/trading.ts`. It:

- Accepts `limit` (0–200, default 50) and `offset` (0–500, default 0) query params, validated by a Zod schema.
- Checks agent ownership (404 if not found).
- Resolves the agent's binding IDs → bot IDs using the existing `selectAgentTradingGrantRows` / `allBindingIds` helpers and a bot query (same pattern as `/activity`).
- Queries `positions` filtered to those bot IDs (`actorType = 'bot'`, `actorId IN (botIds)`), ordered by `openedAt DESC`, with `LIMIT` and `OFFSET`.
- For each position, derives `exitPrice` via a correlated subquery: the `price` from the most recent fill where `actorId = position.actorId`, `symbol = position.symbol`, `filledAt <= position.closedAt` (NULL for open positions). In Drizzle this is expressed as a `.select()` subquery with `.orderBy(desc(fills.filledAt)).limit(1)` aliased on each row.
- Returns:

```json
{
  "agentId": "...",
  "family": "trading",
  "items": [
    {
      "id": "...",
      "symbol": "SOL-PERP",
      "venue": "hyperliquid",
      "side": "long",
      "size": "1.5",
      "entryPrice": "145.00",
      "exitPrice": "152.30",
      "realizedPnl": "10.95",
      "status": "closed",
      "openedAt": "2026-06-01T10:00:00Z",
      "closedAt": "2026-06-01T14:30:00Z",
      "holdMs": 16200000
    }
  ],
  "limit": 50,
  "offset": 0
}
```

- `status` is `"open"` when `closedAt IS NULL`, `"closed"` otherwise.
- `holdMs` is `closedAt - openedAt` in milliseconds (null for open).
- `exitPrice` is null for open positions.

### Web API client

`apps/web/src/lib/api-client.ts` gains:

- `AgentPosition` interface matching the response item shape above, plus `executionMode` (derived from the agent, passed through or fetched separately — see note in Risks).
- `agents.tradingPositions(agentId: string, params?: { limit?: number; offset?: number })` method calling `GET /agents/:agentId/capabilities/trading/positions`.

### Component

`apps/web/src/features/agents/AgentTradesTable.tsx` is a new file containing:

- A `useQuery` call with key `['agents', agentId, 'trading-positions']` and a configurable `refetchInterval` (30 s when agent is active).
- A `<table>` (or equivalent) with columns: **Token** (`symbol`), **Venue**, **Status** (open/closed badge), **Entry** (`entryPrice`), **Exit** (`exitPrice`), **Size** (`size`), **PnL** (`realizedPnl`), **Hold** (formatted duration from `holdMs`), **Mode** (agent `executionMode`, passed as a prop), **Time** (`openedAt` via `<RelativeTime />`).
- Loading state: `<LoadingRows count={5} />`.
- Empty state: localized message.
- Error state: `<ErrorState />` with retry.
- Props: `agentId: string`, `executionMode: string | null`.

### AgentDetailPage integration

`apps/web/src/features/agents/AgentDetailPage.tsx` renders a new `<Card>` section with `<SectionLabel>` below the capabilities `<section>`:

```tsx
{hasTradingCapability && (
  <Card>
    <SectionLabel>{intl.formatMessage({ id: 'agents.detail.tradesHistory' })}</SectionLabel>
    <AgentTradesTable agentId={id!} executionMode={agent.executionMode ?? null} />
  </Card>
)}
```

### i18n

The following keys are added to `apps/web/src/app/i18n/locales/en.ts` (and `ar.ts`, `hi.ts`):

| Key | Default (en) |
|-----|-------------|
| `agents.detail.tradesHistory` | `Trade History` |
| `agents.trades.col.token` | `Token` |
| `agents.trades.col.venue` | `Venue` |
| `agents.trades.col.status` | `Status` |
| `agents.trades.col.entry` | `Entry` |
| `agents.trades.col.exit` | `Exit` |
| `agents.trades.col.size` | `Size` |
| `agents.trades.col.pnl` | `PnL` |
| `agents.trades.col.hold` | `Hold` |
| `agents.trades.col.mode` | `Mode` |
| `agents.trades.col.time` | `Time` |
| `agents.trades.statusOpen` | `Open` |
| `agents.trades.statusClosed` | `Closed` |
| `agents.trades.empty` | `No trade history yet.` |

### Tests

`apps/api/src/__tests__/functional/trading-positions.functional.test.ts` (new file) with the same `buildApp` / `truncateAll` / `registerUser` helpers:

- `returns 404 for an agent belonging to another user`
- `returns empty items when agent has no binding or bots`
- `returns positions with derived exitPrice for closed positions`
- `paginates correctly with limit and offset`

## Scope

### In scope

- New `GET /agents/:agentId/capabilities/trading/positions` endpoint in `trading.ts`.
- `AgentPosition` type and `agents.tradingPositions()` client method in `api-client.ts`.
- `AgentTradesTable` component with all listed columns and states.
- Conditional render in `AgentDetailPage`.
- i18n keys in `en.ts`, `ar.ts`, `hi.ts`.
- Functional tests for the new endpoint.

### Out of scope

- Pagination controls / "load more" in the UI (first page of 50 is sufficient for now).
- Sorting by column.
- Filtering by status (open/closed), venue, or date range.
- Export of this table (the existing `/agents/:id/export/trades` fills-based export is separate).
- Changes to the `fills` or `positions` schema.
- Adding `positionId` FK to `fills`.

## High-Level Plan

1. **Add the Zod query schema and endpoint** in `apps/api/src/routes/capabilities/trading.ts`, after the existing `/outcomes` handler. Add `TradingPositionsQuerySchema` (limit/offset, same bounds as `TradingActivityQuerySchema`). In the handler, reuse `selectAgentTradingGrantRows` + `allBindingIds` + bot ID lookup. Query `positions` with `orderBy(desc(positions.openedAt))` and a SQL subquery for `exitPrice`. Compute `status`, `holdMs`, and format `realizedPnl` to 6dp. Return the paginated response.

2. **Add the `AgentPosition` interface and `tradingPositions` method** in `apps/web/src/lib/api-client.ts`, placed after the `tradingAction` entry in the `agents` object. `tradingPositions` builds a query string from optional `limit`/`offset` params (same pattern as `activityFeed`).

3. **Create `AgentTradesTable.tsx`** in `apps/web/src/features/agents/`. Import `useQuery` from `@tanstack/react-query`, `useIntl` from `react-intl`, `agents as agentsApi` and `AgentPosition` from `../../lib/api-client.js`, and `LoadingRows`, `ErrorState`, `RelativeTime` from `../../lib/ui.js`. The component renders a `<table>` with the 10 columns. `holdMs` is formatted as `Xh Ym` or `Xm` depending on magnitude. `executionMode` is rendered as a plain string (reuse `formatExecutionMode` from `agent-display.ts` if the intl instance is available).

4. **Integrate into `AgentDetailPage.tsx`**: import `AgentTradesTable`, add the guarded `<Card>` section below the existing capabilities `<section>` block (after the closing `</section>` tag on approximately line 420).

5. **Add i18n keys** to `apps/web/src/app/i18n/locales/en.ts`, `ar.ts`, and `hi.ts`. The en locale gets the English defaults above; ar and hi get placeholder translations following the same prefix pattern as existing keys in those files.

6. **Write functional tests** in `apps/api/src/__tests__/functional/trading-positions.functional.test.ts`. Seed data using direct `db.insert()` calls on `positions` and `fills` (same pattern as `exports.functional.test.ts`). Cover the four scenarios listed in the desired end state.

## Risks and Open Questions

- **Exit price derivation in Drizzle**: Drizzle ORM's correlated subquery support requires using `sql` template literals or `.as()` aliased subqueries. The implementor should verify that the version in use (`packages/db/package.json`) supports lateral/correlated selects or fall back to a raw `sql<string>` fragment.
- **`executionMode` in the response**: The `/positions` endpoint currently doesn't need to join `agents` — the `executionMode` is already available in `AgentDetailPage` from the agent query. Passing it as a prop to `AgentTradesTable` is cleaner than embedding it in every position row. This is the chosen approach.
- **i18n regression test**: `apps/web/src/app/i18n/i18n-regressions.test.ts` may assert that all keys present in `en.ts` also exist in `ar.ts` and `hi.ts`. Verify this and add all keys to all three locale files to avoid CI failures.
