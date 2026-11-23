# Agent trading bot details (plan)

Date: 2026-11-23
Status: Draft, ready for review

## Goal

Let a user see the bots their agent created, and what each bot is doing, from the agent's Trading capability. The audience is novice users, so the page leads with plain-language status and money outcomes, and puts technical detail below.

- **Trading tab**
  - A **Bots** section listing every bot this agent created. Each row links to the bot's detail page.
  - A **Child agents** section with one row per child agent that owns bots, for example "2 bots by my-first-child". Each row links to that child's Trading tab.
- **Bot detail page**, at `/agents/:agentId/capabilities/trading/bots/:botId`. Breadcrumb: Agent → Capabilities → Trading → Bot.

## Decisions

- **Agent-scoped.** Users cannot create bots directly today, so there is no user-level bot list.
- **Read-only.** No stop, start, or delete on this milestone.
- **No new endpoints.** The Trading presentation feeds are extended. The bot detail page reads from existing `/bots/:id/*` and `/bots/:botId/positions` routes.
- **Show all of the agent's bots, with the venue shown as a column.** Filtering by the selected venue would hide bots a novice expects to see. The venue is a column, not a filter.
- **Server-computed meaning.** The web renders server-provided strings and does not compute status or emphasis.

## Current state (verified)

- The trading presentation is `GET /agents/:agentId/capabilities/:family/presentation` in [trading.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/trading.ts) (about line 423). It returns `feeds: [tradesFeed, decisionsFeed, fillsFeed]` (about line 851).
- The wire contract is in [presentation.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/presentation.ts). `CapabilityFeedItem` has no link field.
- Bot ownership by agent is `creatorType === 'agent' && creatorId === agentId`. This is the rule in the delete cascade in [agents.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/agents.ts) (about line 784) and in [analytics.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/analytics.ts).
- Child agents are linked by `parentAgentId` (see [agent-create-policy.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/agents/agent-create-policy.ts)).
- The owner-scoped boundary read `list_owner_bots` returns `id`, `status`, `symbol`, `strategyPreset`, `createdAt`, `startedAt`, `venueAccountId`, `creatorType`, and `creatorId`. `strategyPreset` is a lossy label.
- Existing bot read routes, all user-scoped: `GET /bots/:id` (get_owner_bot_status), `GET /bots/:id/costs`, `GET /bots/:id/sessions`, `GET /bots/:id/events`, `GET /bots/:id/journal`, `GET /bots/:id/journal/summary`, and `GET /bots/:botId/positions` (all positions, open and closed). These are in [bots.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/bots.ts) and [views.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/views.ts).
- The old `/bots` and `/bots/:id` pages were removed on 2026-10-02. The web has no bot UI today.

## Plan

### 1. Contract: optional link on feed items

- [presentation.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/presentation.ts): add optional `href?: string` to `CapabilityFeedItem`. The server builds an app-relative path. The web follows it and does not build it.
- Mirror the type in the web's presentation types.
- Additive and optional, so existing feeds are unaffected.

### 2. Backend: Bots feed

- [trading.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/trading.ts): add `botsFeed` (key `bots`), built from `list_owner_bots` with the `loadAgentEvidence` helper and the owner boundary (`userBoundary(userId)`, as in [dashboard.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/dashboard.ts)).
- Filter: `creatorType === 'agent' && creatorId === agentId`. Do not filter by venue.
- Columns, in order: Bot (symbol, with strategy in plain words), Status (badge), Venue (label), Started (timestamp).
- Item `href`: `/agents/{agentId}/capabilities/trading/bots/{botId}`.
- If `list_owner_bots` fails, omit this feed and keep the others. Log the failure.

### 3. Backend: Child agents feed

- Same endpoint. Add `childBotsFeed` (key `childBots`).
- Find direct children with `parentAgentId === agentId`. Count each child's bots from the same `list_owner_bots` result, where `creatorType === 'agent'` and `creatorId` is that child's id.
- One item per child that owns at least one bot. Title: "N bots by {child name}". Item `href`: that child's Trading tab, `/agents/{childId}/capabilities/trading`.
- Children with zero bots are omitted.
- Direct children only. Grandchildren are out of scope for this milestone.
- Dependencies: step 2 (same boundary read, so the feeds share one call).

### 4. Web: feed rendering

- [TradingCapabilityPresentation.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/features/agents/TradingCapabilityPresentation.tsx) renders the feeds through the existing feed component. When an item has `href`, render the row as a link. Rendering is unchanged when `href` is absent.
- The Bots and Child agents feeds appear above Trades, because a novice's first question is "what is my agent running?" Order is decided by the server, so the web only renders the array order it receives.
- Empty state: when the agent has no bots, show one plain line ("This agent has not created any bots yet.") instead of an empty table. The server sends it as an attribute or a feed-level label.

### 5. Web: bot detail page

- Route: add `/agents/:agentId/capabilities/trading/bots/:botId` in [router.tsx](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/app/router.tsx). Confirm it does not clash with `/agents/:agentId/capabilities/:family`.
- Component: new `TradingBotDetailPage.tsx` in `features/agents/`, rendered inside the capability layout.
- Client calls: existing functions in [api-client.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/web/src/lib/api-client.ts) (`bots.get`, `bots.positions`, `bots.journal`, `bots.journalSummary`, `bots.costs`). Check each exists before using it.
- Layout, top to bottom:
  1. **Header:** bot name or symbol, status in plain words ("Running", "Stopped"), and "running since" time.
  2. **Summary cards:** profit or loss, fees paid, number of trades, and what the bot is holding now. Use the server's money values as-is.
  3. **Holdings:** open positions only.
  4. **Recent activity:** the journal as short sentences ("Bought 0.1 BTC at 64,000"), newest first.
  5. **Trades:** all closed positions, with the same columns as the Trades feed.
  6. **Advanced (collapsed by default):** raw config, session list, and cost breakdown.
- Breadcrumb: Agent → Capabilities → Trading → Bot.
- Not found: if the bot is missing or not owned, show a plain "We could not find this bot" state.
- Refresh: poll on the same condition as the Trading tab (every 30s while the agent is active), so the status stays current.
- Dependencies: steps 2 and 4 (the links that lead here).

### 6. Copy

- Add labels using the existing `capability.trading.*` key pattern. Update the text inventory in `docs/features/2026/10/02/002-frontend-trading-text-inventory.md` if it is kept current.
- Keep all user-facing words plain. Avoid terms like "reconciliation", "ledger", or "frontier".

### 7. Tests

Write each case once, in existing test files.

- API, [trading-presentation.test.ts](/Users/chinomso.ikwuagwu/dev_ai/herobids/apps/api/src/routes/capabilities/trading-presentation.test.ts):
  - Bots feed includes only this agent's bots, and includes bots on any venue.
  - Child agents feed counts only direct children's bots, and omits children with zero bots.
  - Item `href` values are correct for both feeds.
  - If `list_owner_bots` fails, both feeds are omitted and the other feeds still return.
- Web:
  - Feed rows render as links when `href` is set.
  - The detail page renders the not-found state.
  - Advanced section is collapsed by default.
- Visual check: one browser pass on the Trading tab, a child agent link, and the detail page, using a novice-style walkthrough.

### 8. Docs

- [CHANGELOG.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/CHANGELOG.md): add an entry.
- [user-acceptance-tests.md](/Users/chinomso.ikwuagwu/dev_ai/herobids/docs/tech/user-acceptance-tests.md): the Bots and Bot Detail sections are marked retired. Add cases for the new surface.
- Keep this plan as `001-plan.md`. Add a short implementation note when done.

## Order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Steps 2 and 3 share one boundary read and should be built together.

## Risks

- **Traderton availability.** If the boundary is down, the bot and child feeds are omitted and the agent page still loads. The detail page shows an unavailable message.
- **Polling cost.** The Trading tab polls every 30s. Adding `list_owner_bots` adds one boundary read per poll. The detail page adds up to five reads per poll. Confirm this is acceptable, or cache briefly server-side.
- **Ownership on the detail page.** Without a new endpoint, the agent check on the bot detail is not enforced on the server. The existing routes only enforce that the bot belongs to the signed-in user. The page can check `creatorId` client-side, but a user who edits the URL to another bot of their own would still see it. Confirm this is acceptable, because the bot belongs to the same user either way.
- **Lossy strategy label.** `strategyPreset` from the list is a label. The detail page should use the raw status from `bots.get`.
- **Created-bot lag.** Traderton's `POST /bots` returns 202 with no id, so a bot may take a moment to appear. The worker's `create_bot` success message says the user "will see it in the bot list". That is misleading and out of scope; track it separately.
- **Money and time values.** Whether profit, fees, and trade count are available in the existing responses still needs checking against the payloads in step 5.

## Open items to check during implementation

- Whether `GET /bots/:id` returns `creatorType` and `creatorId`. If not, the detail page relies on the list's values passed through the link.
- Whether there is a profit or loss total per bot. If not, the summary card uses the sum of closed positions.
