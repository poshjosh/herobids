# Trading Capability Ledger Redesign — P&L Summary, Trades Ledger, Collapsed History

**Date:** 2026-10-03
**Area:** traderton `get_agent_positions` (marks) → herobids API presentation route (`apps/api/src/routes/capabilities/`) → generic web renderers (`apps/web/src/features/agents/CapabilityPresentation.tsx`) → `TradingCapabilityPresentation.tsx`, i18n, UAT
**Type:** Cross-repo feature (traderton read extension + generic presentation-contract extension + frontend redesign)

## Implementation Status

- [DONE] **Item 0 — traderton: opt-in marks on `get_agent_positions`** (`includeMarks`, position-marks helper, ctx wiring, tests, contract doc).
- [DONE] **Item 1 — Presentation contract extension** (`presentation.ts`, `api-client.ts`, ADR 014 note).
- [TODO] **Item 2 — Shared ledger helpers** (`apps/api/src/routes/capabilities/trading-ledger.ts`) + refactor legacy `/positions` onto them.
- [TODO] **Item 3 — Presentation route rewrite** (summary tiles, Trades table, Decisions list with status, Fills table, `PositionRow` mark fields).
- [TODO] **Item 4 — Generic web renderers** (overview tiles + Details disclosure, feed table, collapsed feeds, `labelKey`/`valueKey` localization).
- [TODO] **Item 5 — `TradingCapabilityPresentation` layout**.
- [TODO] **Item 6 — i18n keys** (en/ar/hi).
- [TODO] **Item 7 — Remove orphaned `formatPnl`/`pnlColor` (+ web `decimal.js`), correct ADR 014 Exposure note**.
- [TODO] **Item 8 — Tests** (traderton, API, web, i18n, E2E).
- [TODO] **Item 9 — UAT doc update, ledger fixture, browser UAT runs (desktop + mobile)**.
- [TODO] **Item 10 — CHANGELOGs + verification**.

## Problem

The trading capability page (`/agents/:agentId/capabilities/trading`) shows a
"Trading details" card with six equal-weight tiles and one card holding three
stacked card-lists (Positions / Decisions / Fills) built from `title`/`detail`
strings (`positions` rows read `BTC` / `hyperliquid · 0`). There is no P&L
summary, no win count, no exit price, no open-trade P&L, and the history lists are
hard to scan. Before the traderton extraction herobids had a ledger-style trades
table (`git show 33e5bb58^:apps/web/src/features/agents/AgentTradesTable.tsx`) and
a P&L / trade-count / win-rate line in `AgentSummaryCard` (removed in `c2e3e927`).
The user wants that look back, simpler, for non-expert users.

## Goal

1. A plain-language P&L summary at the top: **Total profit / loss**, **From closed
   trades**, **From open trades**, **Winning trades** ("7 of 12").
2. A primary **Trades** ledger table, one row per position (open + closed), newest
   first, signed P&L in green/red.
3. Secondary account attributes, **Decisions** and **Fills** collapsed by default.
4. Everything stays inside ADR 014: the server emits display strings + semantic
   emphasis; the web renders generically and never inspects values.

## Decisions

1. **Generic contract extension (ADR 014 stays intact).**
   - `CapabilityFeed` += `labelKey?`, `prominence?: 'primary' | 'secondary'`,
     `columns?: CapabilityFeedColumn[]` where
     `CapabilityFeedColumn = { key; label; labelKey?; align: 'start' | 'end'; format: 'text' | 'timestamp' }`.
   - `CapabilityFeedItem` += `cells?: Record<string, CapabilityCell>`, `titleKey?`,
     `badge?: CapabilityCell` (status text shown on list items),
     where `CapabilityCell = { value: string; valueKey?: string; valueParams?: Record<string, string>; emphasis? }`.
   - `CapabilityAttribute` += `labelKey?`, `valueKey?`, `valueParams?`,
     `prominence?: 'primary' | 'secondary'`.
   - `title`/`detail`/`occurredAt` stay populated on every item (list fallback +
     backward compatibility).
   - When `columns` is present the web renders a generic table: horizontal scroll
     on mobile, monospace + right-aligned for `align:'end'`, `RelativeTime` for
     `format:'timestamp'`, emphasis → existing `EMPHASIS_TOKENS` **text colour only**
     (no tinted row backgrounds). `prominence:'secondary'` feeds render inside a
     closed `<details>`. No value inspection anywhere in the web.
   - Mirror the types in `apps/web/src/lib/api-client.ts`. Add a consequence
     note to ADR 014 allowing tabular feeds with per-cell emphasis and server
     label/value keys.
   - *Adjustment vs brief:* decisions stay a list, so list items need `titleKey`
     (localized intent) and `badge` (localized plan status + emphasis). `valueParams`
     is needed for "7 of 12" and durations ("1h 12m").
2. **Layout (non-expert first; no running-balance column).**
   - Primary tiles (`prominence:'primary'`): `total-pnl` (realized + unrealized),
     `realized-pnl`, `unrealized-pnl`, `winning-trades` (`{wins} of {closed}`).
     Totals are over **all** positions for the selected connection's venue
     account, not the limited rows.
   - If any open position has no mark: `unrealized-pnl` = "—" (neutral) and the
     total tile switches to labelKey `capability.trading.attr.totalPnlClosedOnly`
     ("Total profit / loss (closed trades only)") = realized only. Never present a
     partial sum as the total.
   - Secondary attributes (connection, execution mode, authorization, capital,
     open trades, position size mode) go into a closed **Details** disclosure.
     **Warnings stay visible**: the server marks the `warnings` attribute (and
     `capital` when `capitalAvailable === false`) as `prominence:'primary'`.
     These need user action, and hiding them would bury a blocking state. The
     web only follows `prominence`.
   - **Trades** table (`key: 'trades'`, `prominence:'primary'`), newest `openedAt`
     first, `limit` rows. Columns: When (`openedAt`, timestamp) · Asset (symbol) ·
     Direction (Long/Short) · Size · Entry price · Exit price ("—" if open) ·
     Profit / loss (closed: realized; open: unrealized, "—" if no mark) · Held for
     (closed: `closedAt − openedAt`; open: time since open, computed at request
     time — refreshed by the 30s poll) · Status (Open/Closed). No Venue/Mode columns.
   - **Decisions**: secondary list (collapsed). Title = localized intent, detail =
     instrument id, badge = localized latest plan status. Real values (traderton
     `packages/engine/src/planner.ts:23`, `execution_plans.status`):
     `pending | executing | completed | failed`, plus `null` when no plan exists.
     `failed` → `warning`; others → `neutral`; `null` → "Not executed" (neutral).
     There is no `rejected`/`expired` plan status (those are order statuses).
   - **Fills**: secondary **table** (collapsed): When · Asset · Side (Buy/Sell) ·
     Quantity · Price · Profit / loss (`realizedPnlDelta`, "—" when null), newest
     first, `limit` rows. Same renderer as Trades, so there's no extra code path.
   - `ApprovalsPanel` stays unchanged.
3. **Server-side number formatting with Decimal.** `apps/api` already imports
   `Decimal` from `@herobids/domain` (`apps/api/src/routes/agent-config-helpers.ts:2`,
   re-exported by `packages/domain/src/values/money.ts`), so **no new dependency**.
   P&L: round to 2 dp first, then sign: `+12.34`, `-20.00`, rounded zero → `0.00`
   (neutral; avoids a red `-0.00`). No currency symbol. Emphasis comes from the
   **rounded** value. Prices/sizes: `new Decimal(v).toFixed()` (full precision, no
   exponent, trailing zeros trimmed). `pnlEmphasis` moves to Decimal (no
   `parseFloat`). The sign stays in the text, so colour is not the only cue (WCAG 1.4.1).
4. **Unrealized P&L is traderton-owned.** Add `includeMarks?: boolean` (default
   `false`) to `get_agent_positions` rather than a new tool. It's the same scoped
   read and the same rows, and it's opt-in, so the four other herobids consumers
   (`dashboard.ts`, `agents.ts`, `exports.ts`, `blueprint-performance-scorer.ts`,
   plus worker `agent.ts`/`run-evaluation.ts`) are byte-unchanged. A new tool would
   duplicate the scope guards for no gain. When true, **every** row gets
   `markPrice: string | null`, `unrealizedPnl: string | null`, `markedAt: string | null`
   (closed rows → nulls). Per-position failure → nulls, never a failed read.
   See Item 0 for the chain mapping and timeout.
   - No descriptor re-sign: `get_agent_positions` is not in
     `config/external-backends/traderton.descriptor.json` (0 matches). No boundary
     allowlist: traderton `packages/boundary/src/registry.ts` spreads
     `botManagementTools`. No mirror-manifest impact:
     `scripts/parity-drift-manifest.json` (35 paths) does not include
     `tool-contract.ts`, `tools/bots.ts`, `position-tracker.ts` or price files.
     The param **must** be added to `GetAgentPositionsParamsSchema` (zod strips unknown keys).
5. **Localization.** The server sends stable keys (`capability.trading.*`, generic
   `capability.*`) plus the English fallback. The web renders
   `intl.messages[key] ? intl.formatMessage({ id: key }, params) : fallback`. It checks
   `messages` first to avoid react-intl missing-key error noise. Durations and
   "7 of 12" are localized via `valueKey` + `valueParams`. Numbers are emitted as
   display strings (no locale number formatting this round).
   *Correction:* ar/hi are **real translations**, not English mirrors (e.g.
   `agents.capabilityPage.status.readyHeadline` = 'جاهز للتداول' / 'ट्रेड करने के लिए तैयार').
   Provide ar/hi translations for new keys. Parity is enforced by `catalog-consistency.test.ts`.
6. **Remove orphans.** `formatPnl`/`pnlColor` (`apps/web/src/lib/formatting.ts:34–48`)
   have no importers. `decimal.js` is then unused in `apps/web` (its only import is
   `formatting.ts`), so drop it from `apps/web/package.json`. No orphaned P&L i18n
   keys exist (`agents.trades.*` already gone; grep confirmed).
7. **Closed-row Direction / Size (found while reading the code).** On full close,
   traderton `PositionRepository.upsert` (`packages/db/src/repositories.ts:283–296`)
   sets `side:'flat'`, `size:'0'` (entry price and realized P&L kept). So the
   position row can't supply Direction/Size for closed trades. Decision:
   Direction for closed rows = inverse of the side of the matched **closing fill**
   (the same fill `exitPriceFor` already picks: `sell` → Long, `buy` → Short; no
   match → "—"). Size for closed rows = "—". The old table showed `0`, so this is
   not a regression. Follow-up (out of scope): traderton persists the closed
   size/direction at close time.

## Orientation — key files

**traderton** (`/Users/chinomso.ikwuagwu/dev_ai/traderton`)
- `packages/worker/src/tools/bots.ts:1292–1327` — `GetAgentPositionsParamsSchema` + `getAgentPositionsTool`.
- `packages/worker/src/tools/bots.test.ts:1039` — existing `get_agent_positions` tests (`optsArg` equality must keep passing).
- `packages/worker/src/tools/price.ts` — `isOnChainAddress`, `validateSymbolForChain`, `SUPPORTED_CHAINS`.
- `packages/market-data/src/price-service.ts:283–320` — chain routing: `hyperliquid` execution→oracle→cache, `bybit` execution→cache (fail closed), others oracle (DexScreener).
- `packages/worker/src/resolve-swap-assets.ts` — `resolveSwapNetwork(venue, binding?, oneInchConfig?)` (jupiter → solana; 1inch → profile network/chainId → operator config).
- `packages/domain/src/config/schema.ts:17–42` — `SUPPORTED_TOKEN_SAFETY_NETWORKS`, `inferOneInchTokenSafetyNetwork`.
- `packages/domain/src/trading/tool-contract.ts:244` — `TradingToolContext.priceService` (`priceUsd: number`).
- `packages/engine/src/position-tracker.ts:9,128` — `PositionState`, `unrealizedPnl(position, markPrice)`.
- `packages/boundary/src/bin.ts:81,362` — `appConfig`, ctx `priceService` wiring.
- `packages/db/src/schema/positions.ts`, `execution-plans.ts`, `repositories.ts:455` (`loadAgentPositions`), `:950` (`loadAgentDecisions`).
- `docs/features/initial/005-consumer-boundary-contract.md:397–416` — `get_agent_positions` contract.

**herobids API**
- `apps/api/src/routes/capabilities/presentation.ts` — contract types.
- `apps/api/src/routes/capabilities/trading.ts`
  - `PresentationQuerySchema` (163, `limit` default 20, max 100), `DecisionRow`/`toDecisionRow` (170–208, drops `status`), `accountSummaryOf` (210), `pnlEmphasis` (225, parseFloat).
  - Presentation route `GET /agents/:agentId/capabilities/:family/presentation`: **lines 423–621** (sequential reads at 498–546; attributes 549–565; feeds 567–614).
  - Legacy `/agents/:agentId/capabilities/trading/positions`: **lines 913–1028** (`exitPriceFor` 983–1003, `holdMs` 1006–1009).
  - `/state` (336–390) sums realized with parseFloat; out of scope.
- `apps/api/src/routes/exports-traderton.ts` — `PositionRow` (67–86), `FillRow` (36–54), `toPositionRow` (191, spreads `...r`, so extra fields already pass through untyped).
- `apps/api/src/routes/capabilities/trading-presentation.test.ts` (431 lines), `trading.test.ts` (`/positions` exit-price test at 477).
- `apps/api/src/__tests__/functional/helpers.ts:319` — stub `get_agent_positions` (seeded rows; mark fields can be seeded directly).

**herobids web**
- `apps/web/src/features/agents/CapabilityPresentation.tsx` — `EMPHASIS_TOKENS`, `CapabilityAttributes` (also used by `TradingApprovalDetails`, which must keep working), `CapabilityFeeds` (hard-coded "No items yet.").
- `apps/web/src/features/agents/TradingCapabilityPresentation.tsx` — hard-coded "Trading details"; query key `['agents', agentId, 'capabilities', 'trading', 'presentation']`, 30s poll when active.
- `apps/web/src/lib/api-client.ts:1424–1459` — wire types; `presentation()` at 1248.
- `apps/web/src/lib/ui.tsx:382` — `RelativeTime`.
- `apps/web/src/lib/formatting.ts` — orphans.
- `apps/web/src/app/i18n/locales/{en,ar,hi}.ts`, `catalog-consistency.test.ts`, `i18n-regressions.test.ts`.
- Tests: `CapabilityPresentation.test.tsx`, `AgentCapabilityPage.test.tsx` (mocks `TradingCapabilityPresentation`). There is no `TradingCapabilityPresentation.test.tsx` yet.
- E2E: `tests/e2e/journeys/07-agents-page-renders.spec.ts`, `08-agents-capability-reflects.spec.ts` (capability page, Status card only, no feed assertions), `tests/e2e/helpers.ts` (`mockTradingReadiness`).

**Docs:** ADR `docs/tech/architecture/adrs/2026/09/014-capability-agnostic-frontend-presentation.md`; `docs/tech/user-acceptance-tests.md` §6.0a (AG-C01–C06 at 153–158), AG-14 (132); `docs/best-practices/configuration.md`; `docs/runbooks/external-backend-descriptor-signing.md`.

## Implementation

Sequence: **0 → 1 → 2 → 3 → (4, 6) → 5 → 7 → 8 → 9 → 10.** Item 3 depends on 0 at
runtime only. Its tests stub the boundary, and with an older traderton the fields
are absent → nulls → "—".

### 0. traderton — `includeMarks` on `get_agent_positions`

1. `GetAgentPositionsParamsSchema` += `includeMarks: z.boolean().optional().describe(...)`.
   Do **not** forward it to `loadAgentPositions` (keep `optsArg` exactly `{from,to,at}`).
2. New `packages/worker/src/tools/position-marks.ts` (pure, injectable):
   - `toPriceTarget(row, oneInchConfig?) → { symbol; chain; address? } | null`.
     - Venue → chain: `hyperliquid` → `'hyperliquid'`; `bybit` → `'bybit'` (the service
       supports it even though the `get_price` tool enum doesn't); `jupiter` →
       `'solana'`; `1inch` → `resolveSwapNetwork('1inch', undefined, oneInchConfig)`
       (operator `venues.1inch` chainId/tokenSafetyNetwork; `undefined` → null);
       unknown venue → null.
     - Ticker: if `isOnChainAddress(symbol, chain)`, pass the address. Otherwise base = the
       part before the first `-`, `/` or `:` (`BTC-PERP`, `SOL/USDC`, `XYZ-USD`, `BTC/USD:USD`).
     - **Quote guard:** the price service returns USD while `entryPrice` is in quote units. Mark only
       when the quote is USD-like (`USD|USDC|USDT`, or absent for hyperliquid/bybit perps). Otherwise null.
   - `markOpenPositions(rows, { priceService, oneInchConfig, budgetMs, now })`:
     - Only rows with `closedAt === null && side !== 'flat'`.
     - Dedupe lookups by `chain:symbol:address`, run in parallel, and race every lookup against
       **one shared deadline** (`budgetMs`). Late or failed lookups → null.
     - Compute via engine `unrealizedPnl({ ...PositionState from row (Decimal size/entryPrice) }, new Decimal(String(priceUsd)))`.
     - Returns rows + `markPrice` (`toFixed()`), `unrealizedPnl` (`toFixed()`, unrounded; herobids
       rounds for display), `markedAt` (`fetchedAt`).
     - No `priceService` → all nulls.
   - Budget constant `POSITION_MARK_BUDGET_MS = 3_000` (operational mechanics, not trading policy).
     It must stay well under the herobids boundary read deadline (`DEFAULT_READ_TIMEOUT_MS = 10_000`
     in `trading.ts:233`). Comment why.
3. `TradingToolContext` (`tool-contract.ts`) += optional
   `oneInchPriceChainConfig?: { tokenSafetyNetwork?: string; chainId?: number }`.
   Wire it in `boundary/src/bin.ts` from `appConfig.venues?.['1inch']`; confirm the exact
   config path when implementing.
4. Tool: when `includeMarks`, map the result through `markOpenPositions`. Otherwise return the rows untouched.
5. Docs: update `005-consumer-boundary-contract.md` (`get_agent_positions` payload/result +
   null semantics), and traderton `CHANGELOG.md`.
6. Commands: `pnpm lint`, `pnpm test` (focused: `pnpm exec vitest run packages/worker/src/tools`),
   `pnpm build`, then `scripts/shell/tests/run-all-tests.sh`.

### 1. Presentation contract extension

- `apps/api/src/routes/capabilities/presentation.ts`: add `CapabilityCell`,
  `CapabilityFeedColumn`, `CapabilityProminence`, and the optional fields from Decision 1.
  Doc-comment the "web never inspects values" rule on `CapabilityCell`.
- `apps/web/src/lib/api-client.ts`: mirror them exactly (re-exported via `CapabilityPresentation.tsx`).
- ADR 014 Consequences: add a bullet saying that capability feeds may declare `columns`. Items then
  carry per-cell display values with optional semantic emphasis. Labels and word values may carry
  stable i18n keys with an English fallback. The frontend still renders values verbatim and maps
  only emphasis/prominence.

### 2. Shared ledger helpers — `apps/api/src/routes/capabilities/trading-ledger.ts` (new, pure)

- `formatSignedPnl(value: string | null) → { value: string; emphasis }` (Decision 3; null → `{ value: '—', emphasis: 'neutral' }`).
- `formatDecimal(value: string | null) → string` (`toFixed()`, null → '—').
- `pnlEmphasis` → moved here, Decimal-based (rounded 2 dp).
- `indexFillsByPositionKey(fills)` → `Map` keyed by `actorType|actorId|venueAccountId|venue|symbol`.
  This avoids the current O(P×F) loop.
- `findClosingFill(position, fillIndex) → FillRow | null`. This is the exact predicate from
  `exitPriceFor` (`filledAt <= closedAt`, latest wins).
- `closedTradeDetails(position, fillIndex) → { exitPrice: string | null; direction: 'long' | 'short' | null }`
  (Decision 7).
- `holdMsOf(position, now) → number` (closed: close − open; open: now − open).
- `formatDuration(ms) → CapabilityCell`:
  - `<1m` → `capability.trading.duration.lessThanMinute`
  - `<1h` → `.minutes {minutes}`
  - `<1d` → `.hoursMinutes {hours,minutes}`
  - else → `.daysHours {days,hours}`
  - English fallback in `value`.
- `summarizeTrades(rows) → { realized: Decimal; unrealized: Decimal | null; wins; closed; openCount }`.
  `unrealized` is null if any open row lacks `unrealizedPnl`. Wins = closed rows with rounded realized > 0.
- Refactor the legacy `/positions` route to use `indexFillsByPositionKey` + `findClosingFill` +
  `holdMsOf`. Its response must stay **byte-identical**, including `realizedPnl` `toFixed(6)` and
  `holdMs: null` for open rows. Pass a closed-only flag, or keep the open→null mapping in the route.
  The existing `trading.test.ts:477` guards this.

### 3. Presentation route rewrite (`trading.ts` 423–621)

1. `PositionRow` (`exports-traderton.ts`) += optional `markPrice?`, `unrealizedPnl?`, `markedAt?`
   (`string | null`). `toPositionRow` already spreads them; add a comment.
2. `DecisionRow` += `status: string | null`; `toDecisionRow` reads `r['status']` (string or null).
3. Load the four reads with `Promise.all`. Keep a deterministic error precedence of
   summary → positions → decisions → fills, so status mapping is unchanged. This offsets the added
   mark latency. Pass `get_agent_positions` `{ includeMarks: true }`.
4. Filter positions/fills by `resolvedVenueAccountId` **before** summarizing (same cross-connection
   rule as today). Totals use the filtered full set. Only the table is `slice(0, limit)` after
   sorting by `openedAt` desc. Fills: sort `filledAt` desc, then `slice(0, limit)`.
   `limit` now applies to trades/decisions/fills; update the comment at 437–439.
5. Attributes (every one carries `labelKey`):
   - **Primary:** `total-pnl`, `realized-pnl`, `unrealized-pnl`, `winning-trades`
     (`valueKey: capability.trading.value.winsOfClosed`, `valueParams: { wins, closed }`,
     neutral emphasis). Plus `warnings` when present, and `capital` when `capitalAvailable === false`.
   - **Secondary:** connection, execution-mode (`valueKey` `capability.trading.executionMode.<v>` for
     `paper|shadow|live`; confirm the value set), authorization (`capability.trading.authorization.<v>`;
     confirm the set from the agent config schema; unknown → raw), capital, open-positions
     (relabelled "Open trades"), position-size-mode.
   - "Not set" → `valueKey: capability.trading.value.notSet`.
6. Feeds:
   - **`trades`** (primary, columns per Decision 2; `title` = symbol, `detail` = `"<direction> · <pnl>"`,
     `occurredAt` = `openedAt`).
     - Open row: Direction = `side`, Size = `formatDecimal(size)`, Exit = '—',
       P&L = `formatSignedPnl(unrealizedPnl ?? null)`.
     - Closed row: Direction from `closedTradeDetails`, Size '—', Exit = `exitPrice ?? '—'`,
       P&L = `formatSignedPnl(realizedPnl)`.
     - Status cell `valueKey` `.value.open|closed`; Direction `valueKey` `.value.long|short`.
   - **`decisions`** (secondary list): `titleKey: capability.trading.intent.<intent>` (fallback =
     intent with `_` → space), `badge` = status cell per Decision 2.
   - **`fills`** (secondary, columns per Decision 2): Side `valueKey` `.value.buy|sell`,
     P&L `formatSignedPnl(realizedPnlDelta)`.
   - Feed `labelKey`s: `capability.trading.feed.trades|decisions|fills`.
7. The `connection: null` / 404 / 503 paths are unchanged.

### 4. Generic web renderers (`CapabilityPresentation.tsx`)

- `localizeText(intl, key, fallback, params?)`: `intl.messages[key]` ? `formatMessage` : fallback.
  Used for every label/value/title/badge.
- `CapabilityAttributes` keeps the current grid (approval details depend on it) and now localizes
  `labelKey`/`valueKey`.
- New `CapabilityOverview({ attributes })`:
  - Non-`secondary` attributes render as large tiles: neutral surface background, value
    `1.25rem` monospace, coloured by emphasis token **text colour**.
  - `secondary` attributes render inside `<details><summary>{capability.details}</summary>` via
    `CapabilityAttributes`.
- `CapabilityFeeds`:
  - `feed.prominence === 'secondary'` → wrap in a closed `<details>` whose `<summary>` is the label.
  - `feed.columns` → `CapabilityFeedTable`:
    - `<div role="region" aria-label={label} tabIndex={0} style={{overflowX:'auto'}}>` around a
      `<table>` with `<th scope="col">`.
    - `align:'end'` → right-aligned monospace, `whiteSpace:'nowrap'`.
    - `format:'timestamp'` → `RelativeTime` (with the ISO `title`).
    - Missing cell → '—'. Cell emphasis → `EMPHASIS_TOKENS[e].color` only.
  - Otherwise use the existing list, plus `titleKey` and a right-aligned `badge` text coloured by its emphasis.
  - "No items yet." → `capability.feed.empty`.
- No imports of `formatting.ts`, `decimal.js`, or `parseFloat`/`Number(` on values.

### 5. `TradingCapabilityPresentation.tsx`

- Replace the "Trading details" `Card` with a `Card` containing `CapabilityOverview`.
- Next, a `Card` with `CapabilityFeeds` (Trades open; Decisions/Fills collapsed by server prominence).
- Then `ApprovalsPanel`. The funding banner, query, and polling are unchanged. Localize the banner's
  hard-coded "Dismiss" with the existing `common.dismiss` if present (check), otherwise leave it.
- No trading branching added; all structure comes from the payload.

### 6. i18n keys (en/ar/hi, translated)

Generic: `capability.details` "Details", `capability.feed.empty` "No items yet."

Trading (`capability.trading.*`):
- `attr.totalPnl` "Total profit / loss"
- `attr.totalPnlClosedOnly` "Total profit / loss (closed trades only)"
- `attr.realizedPnl` "From closed trades"
- `attr.unrealizedPnl` "From open trades"
- `attr.winningTrades` "Winning trades"
- `attr.connection` "Connection"
- `attr.executionMode` "Execution mode"
- `attr.authorization` "Authorization"
- `attr.capital` "Capital"
- `attr.openPositions` "Open trades"
- `attr.positionSizeMode` "Position size mode"
- `attr.warnings` "Warnings"
- `feed.trades` "Trades"
- `feed.decisions` "Decisions"
- `feed.fills` "Fills"
- `col.when` "When"
- `col.asset` "Asset"
- `col.direction` "Direction"
- `col.size` "Size"
- `col.entryPrice` "Entry price"
- `col.exitPrice` "Exit price"
- `col.pnl` "Profit / loss"
- `col.heldFor` "Held for"
- `col.status` "Status"
- `col.side` "Side"
- `col.quantity` "Quantity"
- `col.price` "Price"
- `value.long` "Long", `value.short` "Short"
- `value.open` "Open", `value.closed` "Closed"
- `value.buy` "Buy", `value.sell` "Sell"
- `value.notSet` "Not set"
- `value.winsOfClosed` "{wins} of {closed}"
- `decisionStatus.pending` "Waiting"
- `decisionStatus.executing` "In progress"
- `decisionStatus.completed` "Done"
- `decisionStatus.failed` "Failed"
- `decisionStatus.none` "Not executed"
- `intent.go_long` "Open long"
- `intent.go_short` "Open short"
- `intent.go_flat` "Close position"
- `intent.increase` "Increase position"
- `intent.decrease` "Reduce position"
- `duration.lessThanMinute` "<1m"
- `duration.minutes` "{minutes}m"
- `duration.hoursMinutes` "{hours}h {minutes}m"
- `duration.daysHours` "{days}d {hours}h"
- `executionMode.paper|shadow|live`
- `authorization.<values>`

### 7. Orphans + ADR correction

- Delete `formatPnl`/`pnlColor` and the `decimal.js` import from `apps/web/src/lib/formatting.ts`.
  Remove `decimal.js` from `apps/web/package.json` and run `pnpm install` to update the lockfile.
- Update the stale comment in `CapabilityPresentation.test.tsx:39`.
- ADR 014: replace the "Exception: … ExposurePage …" sentence. `ExposurePage`/`/exposure` were deleted
  (`docs/features/2026/10/02/002-frontend-trading-text-inventory.md`), and `formatPnl`/`pnlColor`
  are now removed with no remaining exception.

## Tests

**traderton (`packages/worker/src/tools/`)**
- `bots.test.ts` (`get_agent_positions`):
  - Default/`includeMarks:false` returns rows untouched, and `optsArg` is still `{from,to,at}`.
  - `includeMarks:true` adds the three fields to every row (closed → nulls).
  - Price failure → nulls, success:true.
  - No `priceService` → nulls.
- New `position-marks.test.ts`:
  - Venue→chain mapping (hyperliquid, bybit, jupiter→solana, 1inch via operator chainId 8453→base,
    unmapped chainId → null, unknown venue → null).
  - Ticker/address derivation and the quote guard (SOL-quoted → null).
  - Long/short unrealized maths via engine.
  - Dedupe (one lookup for two rows).
  - Shared-deadline timeout with fake timers: a slow lookup → null, a fast one still marked.

**herobids API**
- New `trading-ledger.test.ts`:
  - Signed 2dp formatting (`12.345`→`+12.35`, `-20`→`-20.00`, `-0.004`→`0.00` neutral).
  - Decimal emphasis, `formatDecimal` trimming/no exponent (`0.00000012`).
  - Closing-fill selection + direction inversion, `holdMsOf` open/closed, `formatDuration` buckets.
  - `summarizeTrades` (wins/closed, unrealized null when any open mark is missing).
- `trading-presentation.test.ts` (update existing + add):
  - Attribute keys, prominence and labelKeys.
  - Feed keys `trades|decisions|fills`; columns shape.
  - Cells: signed P&L + emphasis positive/negative/neutral; open row uses unrealized; null mark → "—";
    closed direction from fill; size "—".
  - Totals over the full set when `limit` < rows.
  - "Closed trades only" total label when a mark is missing; win string params.
  - Decision badge from `status` (`failed`→warning, `null`→"Not executed").
  - `get_agent_positions` invoked with `{ includeMarks: true }`.
  - Cross-connection rows are excluded from table **and** totals.
  - Existing null/404/503 tests stay green (503 precedence under `Promise.all`).
- `trading.test.ts`: the `/positions` exit-price test is unchanged and green (byte-identical refactor).

**herobids web**
- `CapabilityPresentation.test.tsx`:
  - Table renders headers/cells.
  - `align:'end'` monospace.
  - Cell emphasis maps to token colour regardless of value (`'-5.00'` with `positive` → success colour).
  - `labelKey`/`valueKey` localize with messages, fall back without.
  - `valueParams` interpolation.
  - Overview primary/secondary split (secondary inside `<details>`).
  - Secondary feed collapsed.
  - Badge on list items.
  - Generic fixture with no trading words still renders (AG-C05 guard).
- New `TradingCapabilityPresentation.test.tsx`: seed the QueryClient with a presentation fixture,
  then assert tile order, the Trades table, and Decisions/Fills `<details>` without `open`.
- `AgentCapabilityPage.test.tsx`: unchanged behaviour; adjust only if the mount contract changes.
- `i18n-regressions.test.ts`:
  - Add a case that `CapabilityPresentation.tsx` / `TradingCapabilityPresentation.tsx` contain no
    `formatPnl|pnlColor|decimal.js|parseFloat`.
  - Add a case that `formatting.ts` no longer exports them.
  - Add a case that every server-emitted key exists in `en`. Keep an explicit list in the test,
    mirrored from the API constants.

**E2E**
- Journeys 07/08 only assert the Status card; there are no feed assertions, so no change is needed.
  Re-run them.
- New `tests/e2e/journeys/19-trading-ledger-renders.spec.ts`. Register + create an agent via API,
  `mockTradingReadiness(...).setReady(...)`, and `page.route` the `/presentation` endpoint with a
  fixture (one winning closed, one losing closed, one open row). Then assert:
  - The tiles show `+`/`-` text.
  - The Trades table has 3 rows, with `+12.34` coloured by success token and `-20.00` by danger token
    (computed style).
  - Decisions/Fills are collapsed and expand on click.

## UAT

Update `docs/tech/user-acceptance-tests.md` §6.0a and run each UAT in the browser against
`scripts/shell/run/reset-and-run-xstack.sh` (web `http://localhost:8090`). Record date / herobids +
traderton commits / evidence in Notes, like the existing rows.

**Fixture (deterministic).** Add a dev-only `scripts/shell/run/seed-ledger-fixture.sh <agentId>`:
1. Read the agent's ready connection `resolved_venue_account_id` from herobids pg
   (`docker exec herobids-postgres-1 psql …`).
2. Insert into traderton pg (host `:5433`):
   - a closed winning position (`realized_pnl 12.34`, `side flat`, `size 0`) + its open/close fills;
   - a closed losing position (`-20`) + fills;
   - one open hyperliquid `BTC` long (`size 0.01`), all `actor_type 'agent'`, `actor_id <agentId>`;
   - two decisions with `execution_plans` statuses `completed` and `failed`, and one decision with no plan.
3. Print the page URL.
- Use a paper-mode agent from the default setup.
- The open-row mark needs network access to Hyperliquid. Without it, verify the "—" + "closed trades
  only" path and note it. No real trading is involved.

**Rewrite / re-run**
- **AG-C02:** expected now also says the tiles and Trades rows belong only to the selected
  connection (the second connection's seeded rows absent).
- **AG-C03:** unchanged text; re-run (no tiles/tables on unavailable).
- **AG-C04:** "positive/negative/warning/neutral emphasis on attributes **and table cells / list
  badges** applied as text colour from backend emphasis only; sign remains in the text."
- **AG-C05:** add "tabular feeds render through the same generic table with no trading branch".
- **AG-C06:** add "Trades table scrolls horizontally inside its region; tiles wrap; Details/Decisions/Fills
  disclosures operable at 390×844."
- **Regression:** AG-14 (Status card unchanged) and AG-C01 (generic `/agents` list/detail still show no
  P&L / win rate).

**New rows**
- **AG-C07 Trading P&L summary tiles:** four tiles show the expected values over all trades
  (`+12.34 − 20.00 + unrealized`), "1 of 2" winning, green/red by sign.
- **AG-C08 Trades ledger:** one row per position, newest first, signed coloured P&L incl. unrealized for
  the open row ("—" if no mark), exit "—" for open, Held for, Open/Closed.
- **AG-C09 Collapsed history:** Details, Decisions (with Done / Failed (warning) / Not executed) and
  Fills are collapsed by default and expand.
- **AG-C10 Localized labels:** switch to ar and hi. Tile labels, column headers, Long/Short, Open/Closed,
  statuses and durations are translated. Numbers stay `+12.34`. RTL layout is not broken in ar.

**Run:** final step via VisualTester / Playwright MCP. Desktop 1280×800 pass for all listed rows, then
a 390×844 mobile pass (AG-C06, C07, C08). Check console errors = 0 and that `/presentation` returns 200.

## Verification

- traderton: `pnpm lint`, `pnpm test`, `pnpm build`, `scripts/shell/tests/run-all-tests.sh`.
- herobids:
  - focused suites first: `pnpm exec vitest run apps/api/src/routes/capabilities apps/web/src/features/agents apps/web/src/app/i18n`;
  - then `pnpm lint` (`noUnusedLocals`: remove a dead `pnlEmphasis` import or `exitPriceFor` closure);
  - then `pnpm test`, `pnpm build`, `scripts/shell/tests/run-all-tests.sh --e2e`;
  - `pnpm exec vitest run apps/worker/src/external-backend` (descriptor parity; expect no change).
- UAT browser runs (above), recorded in the UAT doc.
- CHANGELOG `[Unreleased]` entries in both repos (traderton: `includeMarks`; herobids: ledger redesign,
  contract extension, orphan removal).

## Out of scope

- Locale-specific number formatting (digits/decimal separators); currency symbols.
- A running-balance column; pagination/cursor (`nextCursor` still unused); charts.
- Persisting closed trade size/direction in traderton (Decision 7 follow-up).
- `/state` and legacy `/positions` P&L parseFloat; `TradingApprovalDetails` hard-coded English labels.
- Mark staleness display; per-connection mark scoping inside traderton (marks are computed for the
  agent's open positions; usually few).

## Risk / rollback

- **traderton change is opt-in.** Default callers are unchanged. Rollback = revert the tool/helper;
  herobids then shows "—" + "closed trades only".
- **Herobids:** contract fields are optional and `title`/`detail` stay populated, so an older web build
  still renders lists. Rollback = revert the API route + web files + i18n.
- **Latency:** marks add up to 3s worst case, mitigated by `Promise.all` and the shared deadline.
  Watch the boundary timeout on slow price sources.
- **Mark correctness:** USD-vs-quote mismatch is guarded (null). A 1inch binding-level chain override is
  not visible to the boundary tool, so the operator chain is used. A mismatch yields a wrong or
  failed lookup; failures become null.
- **Closing-fill attribution** reuses the accepted `exitPriceFor` predicate. Reversal closes share one
  fill (direction still correct).

## Outstanding Issues

### Item 1 — Presentation contract extension (no CRITICAL/HIGH)
- [LOW] API types use `type` aliases while the mirrored web types use `interface`; structurally identical and each matches its file's local convention. (The MEDIUM re-export of the new types via `CapabilityPresentation.tsx` was fixed in-item.)

### Item 0 — traderton opt-in marks (no CRITICAL/HIGH)
- [LOW] `MarkOpenPositionsDeps.now` is accepted but unread on success paths (`markedAt` uses the price source `fetchedAt`). Kept for a stable signature; documented inline.
- [LOW] `MarkPriceService.source: string` is wider than the real union (`'execution'|'oracle'|'cached'`); mirroring the union would make the local interface more honest.
- [LOW] Module-header doc nit: says "a single price lookup per distinct asset"; precisely it is per distinct `chain:symbol:address` (the dedupe comment is correct).

