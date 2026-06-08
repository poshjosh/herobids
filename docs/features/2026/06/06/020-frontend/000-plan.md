# 020 — Frontend Completeness

## Status
`todo`

## Goal
Bring the herobids web UI to feature parity with aitradingbot. Tracked at the page/feature level; individual component work is tracked in sub-tasks as needed.

## Scope

### Pages to build or complete

| Page | Route | Status | Notes |
|---|---|---|---|
| Blueprints list | `/blueprints` | missing | 3-tab creation wizard, preset cards grid, list with Edit/Delete/Publish actions |
| Blueprint edit | `/blueprints/:id` | missing | JSON/YAML toggle, "Apply preset" dropdown |
| Bot creation wizard update | `/bots/new` | partial | Update Step 1 to use blueprint reference; add wallet import inline |
| Analytics | `/analytics` | missing | Cross-bot/agent query with groupBy, date range, charts |
| Sessions | `/sessions` | missing | Paginated list + detail with costs |
| Docs | `/docs` | missing | In-app documentation index + per-page markdown renderer |
| Skills | `/skills` | missing | List, create, edit, fork |
| Export UI | bot detail + settings | missing | Export dropdown on bot detail page; account export on settings page |
| AI model picker | settings + bot creation | missing | Chain picker (Primary + 2 fallbacks) in settings and bot create wizard |
| WebSocket integration | global | missing | Subscribe on login, propagate events to relevant pages without polling |

### Pages that exist but need completion

| Page | Gap |
|---|---|
| Bot detail (`/bots/:id`) | Add events tab, journal tab, costs tab, export dropdown |
| Agent detail (`/agents/:id`) | Add state panel, bots list, memory viewer, send-message input |
| Settings | Add AI model chain picker section |
| Billing | Add ledger table with pagination and filters |

## Notes

- The Blueprints 3-tab wizard (`From Existing / From Defaults / Custom`) is the most complex UI component. Design it as a reusable component (`BlueprintCreator`) usable in both `/blueprints` and the bot creation wizard.
- AI generate-config flow requires `POST /ai/generate-config` (from 017). Frontend can show the UI but disable "Generate" if no AI provider is configured (check `GET /ai/available-models`).
- Docs page: render markdown from a `/docs/` static asset or from in-repo `.md` files served by the API. Lazy-load individual pages.
- WebSocket: connect in a global provider on auth, push events into relevant React Query caches to avoid polling.

## Acceptance criteria

Per feature:
- [ ] Blueprints: UAT tests from aitradingbot `docs/tech/user-acceptance-tests.md` (Blueprints section) all pass
- [ ] Bot detail: events, journal, costs tabs render real data
- [ ] Agent detail: state panel shows PnL and positions; managed bots list visible
- [ ] Settings: AI model chain picker saves and persists
- [ ] WebSocket: bot status changes appear in real time without page refresh
- [ ] All new routes wired into `router.tsx`
- [ ] `pnpm lint` passes (frontend tsconfig strict)
