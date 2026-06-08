## Gap Analysis: herobids vs aitradingbot

### What herobids already has

| Area | Status |
|---|---|
| Auth (register, login, refresh, OAuth callback) | ✅ |
| Agents — CRUD, start, stop, pause, resume | ✅ |
| Agents — activity, artifacts, sessions, messages, decisions | ✅ |
| Bots — create, start, stop, get, positions | ✅ |
| Credentials + Venue Accounts | ✅ (different model) |
| Billing — checkout, portal, webhooks (Stripe + Creem) | ✅ |
| Dashboard / activity feed | ✅ |
| Backtests — create, list, get, cancel | ✅ |
| Journal, positions, reconciliation | ✅ |
| Agent platform runtime (containers, Redis streams, message catalog) | ✅ documented, partially implemented |

---

### The gaps (grouped by priority)

**P0 — Core bot/agent data surface (users need this to do anything useful)**

| What's missing | aitradingbot analogue |
|---|---|
| Bot cost summary | `GET /api/bots/:id/costs` |
| Bot sessions | `GET /api/bots/:id/sessions` |
| Bot events / activity feed | `GET /api/bots/:id/events` |
| Bot journal + journal summary | `GET /api/bots/:id/journal[/summary]` |
| Agent live trading state (PnL, positions, capital) | `GET /api/agents/:id/state` |
| Agent bots list | `GET /api/agents/:id/bots` |
| Agent cost summary | `GET /api/agents/:id/costs` |
| Agent journal | `GET /api/agents/:id/journal` |
| Billing ledger (paginated cost records) | `GET /api/billing/ledger` |
| Sessions list + detail | `GET /api/sessions[/:id]` |
| `tradingInstanceId` → `botId` rename (open R1.1) | — |
| Plan quota TOCTOU fix | — |

**P1 — Blueprints/Configs system (MAJOR gap)**

aitradingbot has a full blueprint lifecycle; herobids bakes config into bot creation with no standalone management:

| What's missing |
|---|
| `GET/POST /api/configs` — list, create |
| `GET/PUT/DELETE /api/configs/:id` — CRUD |
| `GET /api/configs/defaults` + `/presets` |
| `POST /api/configs/from-preset` — preset builder |
| `POST /api/configs/:id/clone` |
| `POST /api/configs/:id/publish` / `unpublish` — marketplace |
| Frontend Blueprints page (3-tab creation wizard, edit page, preset cards) |

**P2 — Agent interactivity**

| What's missing |
|---|
| `POST /api/agents/:id/message` — send message to running agent |
| `GET /api/agents/:id/memory` — agent memory entries |
| `GET /api/agents/:id/prompt` — last compiled system prompt |
| `GET /api/agents/:id/trades` |
| Agent full update: `PUT /api/agents/:id` |
| Telegram webhook + verify-telegram + get-telegram-bot |
| Agent export endpoints (trades, journal, costs, sessions, config, bundle) |

**P3 — Analytics, AI endpoints, exports**

| What's missing |
|---|
| `GET/POST /api/analytics` — rich cross-bot/agent query |
| `GET /api/ai/available-models` |
| `POST /api/ai/generate-config` — AI config generation |
| `POST /api/ai/analyze-portfolio` |
| `POST /api/ai/explain-signal` |
| `PATCH /api/settings/ai-model` |
| Bot export bundle (`/api/bots/:id/export/*`) |
| Account-level export (`/api/export/trades`, `/api/export/bundle`) |
| Skills CRUD + fork (`/api/skills`) |

**P4 — Admin, WebSocket events, frontend completeness**

| What's missing |
|---|
| `GET /api/admin/stats` / users / `/containers` |
| WebSocket real-time event stream (`/events?token=...`) |
| Frontend: Blueprints, Analytics, Backtests UI, Sessions, Docs page, Skills, AI generate-config flow, Export UI |

---

### What to do next — my recommendation

The aitradingbot's approach (UAT shell script + integration tests under `tests/**/*-integration.test.ts`) is a solid pattern. For herobids it would work even better as an **executable gap tracker**. Here's what I'd propose:

**Option A: Test-driven gap tracking (recommended)**

1. Write a `shell/tests/run-uat.sh` for herobids that mirrors aitradingbot's UAT script against the actual herobids API surface.
2. For each missing endpoint, add a `fail` clause immediately — failing tests become the implementation queue.
3. As each feature lands, the test passes. The script is the living parity checklist.
4. Complement with a `tests/api/**/*-integration.test.ts` suite in vitest for endpoints that need more structured assertions (response schemas, edge cases, plan limits).

**Option B: Stub-first (faster to scaffold the backlog)**

1. Add every missing endpoint as a `501 Not Implemented` stub with correct path and auth guard.
2. Write integration tests against all of them (they all fail immediately).
3. Implement by priority, tests go green one by one.
4. Advantage: you get the full API surface documented and testable before a line of real logic is written.

**I'd combine both**: stubs for structure + UAT script for end-to-end confidence. The clear priority order would be:

```
P0: R1.1 rename + bot/agent data surface + billing ledger
P1: Blueprints/Configs system (biggest functional gap)
P2: Agent interactivity (message, memory, prompt)
P3: Analytics + AI endpoints
P4: Admin + WebSocket + frontend completeness
```


### A clarifying question before we proceed

#### Question

Should the blueprints/configs system in herobids stay as a separate concept (like aitradingbot), or should we collapse it into the existing bot config JSONB model with a "saved presets" table? The aitradingbot model decouples config from bot lifecycle; herobids currently embeds config in the bot — that's an architecture decision that affects schema, not just API surface.

#### Answer

Separate concept is more flexible** — and notably, it's already what the herobids domain model specifies.

From domain-language.md:

> **Blueprint** — The configuration specification for a bot... It is the stable, versioned, user-configured part of a bot. The blueprint does not change when a bot is started or stopped. Changing the blueprint increments `configVersion`.

The current implementation hasn't built the separate `blueprints` table yet — the config is embedded in `bots.config` as a temporary shortcut, not an intentional design choice.

**Why separate is more flexible:**

- **Reuse** — multiple bots can share one blueprint; change the blueprint, all derived bots see it (or not, with versioning)
- **Bot/run history** — a bot run always references the blueprint version it started with; with embedded config you lose that audit trail when config is mutated
- **Agent lifecycle authority** — an agent creates a bot by saying "use blueprint X"; cleaner than passing a full config blob in the message protocol
- **Marketplace / presets** — natural fit for `publish`/`clone`; awkward with per-bot JSONB
- **The rename** — `tradingInstanceId → botId` (open R1.1) is cleaner once bot is a thin reference to a blueprint rather than a config container

**The "saved presets" collapsed model** gains only simplicity in the short term and loses all of the above. It also drifts further from the documented domain language, which creates confusion for any agent reasoning over the data model.

**Practical implication:** the P1 work isn't adding a new concept — it's building the `blueprints` table that the domain model already describes, migrating `bots.config` to `bots.blueprintId`, and surfacing the CRUD routes. The embedded config can remain as a snapshot (`bots.configSnapshot`) for audit purposes during the transition.