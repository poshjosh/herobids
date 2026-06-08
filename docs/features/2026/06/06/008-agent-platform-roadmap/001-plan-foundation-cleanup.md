# Plan 1: Foundation Cleanup

**Phase:** 1
**Status:** `in progress`
**Depends on:** Nothing — this is the baseline.
**Roadmap:** [000-roadmap.md](./000-roadmap.md)

## Progress

| Step | Description | Status |
|---|---|---|
| 1.1 | DB schema designed and reviewed | `done` |
| 1.2 | Drizzle migrations wiped and regenerated | `done` — `bots`, `user_credentials`, `agent_credentials`, `skills` in migrations; no `trading_instances` |
| 1.3 | Rename propagated: domain types, DB, worker, API | `partial` — DB done; `TradingInstanceId`/`TradingInstanceConfig*` still in `packages/domain/src/`; `instances.ts` route not renamed to `bots.ts`; `/instances` → `/bots` web rename not done |
| 1.4 | Agent create form fields: API + UI | `done` — `name`, `prompt`, `skillPreset`, `telegramChatId` collected |
| 1.5 | Agent skill presets replace strategy presets | `done` — `trading` / `reminder` / `custom` presets in domain, API, and UI |
| 1.6 | Strategy presets added to bot create | `not done` — no `/bots` route or web page exists yet |
| 1.7 | Agent lifecycle authority: `manage_bot` capability | `done` — in `capability-policy.ts` and `agent-message-broker.ts` |
| 1.8 | `send_message` in capability grants + broker policy | `done` — registered, rate-limited, persisted `toolPolicy` respected |
| 1.9 | Safety alert wiring completed | `partial` — `runtime_failed` and `runtime_unhealthy` fire; `paused_by_guardrail` and `critical_execution_failure` not wired in `agent-session-manager.ts` |
| 1.10 | Decisions card + Objective card in AgentDetailPage | `done` |
| 1.11 | Delete control wired in AgentDetailPage | `not done` — delete API endpoint exists; UI button not wired |
| 1.12 | `/bots` page renamed + UI naming fixed | `not done` — `/instances` page and `instances.ts` route still exist; no `/bots` web feature |
| 1.13 | `pnpm lint` passes, all tests pass | `done` |

## Goal

Correct the domain model, align naming with the agreed language, complete the remaining MVP gaps, and ensure what is shipped is internally consistent before further layers are added.

## Context

The preliminary re-assessment ([007-re-assessment/001-preliminary-report.md](../007-re-assessment/001-preliminary-report.md)) and 005-agent-mvp-rollout-plan/001c-mvp-delivery-remaining.md together identify four categories of gaps:

1. **Domain model misalignment** — `trading_instances` conflates config and runtime; "bot" and "blueprint" are not first-class; agent presets are wrong (strategy presets, not skill presets)
2. **MVP capability gaps** — capability registration, broker policy enforcement, safety alert wiring
3. **UI gaps** — decisions card, objective card, relink/delete controls, naming confusion
4. **Naming and UX hygiene** — buttons, placeholders, page titles

---

## Deliverables

### 1. Domain Language Document

Create `docs/tech/domain-language.md` defining the canonical terms:
- Agent, Bot, Blueprint, Bot Run, Skill Preset, Strategy Preset, Venue Account, Decision, Trading Instance, Actor, Platform Safety Alert

Status: **Done** — created in this session.

---

### 2. Rename `trading_instances` → `bots` And Introduce Blueprint

This is a cross-cutting rename with a structural split. It must be done atomically or in a single well-scoped migration.

#### 2a. DB schema changes

File: `packages/db/src/schema/trading-instances.ts` → rename to `bots.ts`

- Rename the Drizzle table from `trading_instances` to `bots`
- Rename the exported constant from `tradingInstances` to `bots`
- Extract blueprint fields into a conceptual grouping (no separate table in MVP — keep one row per bot, but clearly document which fields are blueprint fields vs runtime fields):
  - **Blueprint fields** (config/spec): `strategyId`, `config`, `venueAccountId`, `configVersion` (no `portfolioId` — dropped)
  - **Runtime fields** (operational): `status`, `startedAt`, `stoppedAt`
- Rename `uq_trading_instances_active_venue_account` constraint to `uq_bots_active_venue_account`
- Rename indexes accordingly
- `creatorType` / `creatorId` replace `agent_instance_links`
- `portfolioId` column and `portfolios` table are **dropped** (no MVP benefit)

> **Note on Blueprint split:** A full separate `bot_blueprints` table and `bot_runs` table is the correct long-term shape. For this phase, keep one `bots` table but document the conceptual boundary clearly in code comments. The split into separate tables is deferred to Phase 2 or a dedicated migration phase once the rename is stable.

**Replace `agent_instance_links` with `creatorId`/`creatorType` on the `bots` table.**

Drop the separate link table entirely. Add two columns to the `bots` table:
- `creatorType: text` — `'agent'`, `'user'`, or `'system'`
- `creatorId: text` — the ID of the creating actor (agentId, userId, or null for system)

This correctly models the reality that every bot has exactly one creator, and that creator may be any actor type. It also removes the artificial one-active-link-per-agent constraint.

Delete `packages/db/src/schema/agent-instance-links.ts` and remove all references to `agent_instance_links` / `agentInstanceLinks` across the codebase.

The link table had an implicit session guard: `UNIQUE (agent_id) WHERE status = 'active'`. Dropping it without replacing this constraint would leave a race window where two `startAgent` calls could create two active sessions. Add this constraint to `agent_runtime_sessions` in the same migration:
```sql
UNIQUE (agent_id) WHERE status NOT IN ('stopped', 'crashed')
```
Drizzle: `uniqueIndex('uq_agent_runtime_sessions_active_agent').on(t.agentId).where(sql\`${t.status} NOT IN ('stopped', 'crashed')\`)`

Also in this migration:
- `agent_runtime_sessions`: drop `tradingInstanceId` column — sessions are agent-scoped, not agent+bot-scoped
- `agent_messages`: replace `tradingInstanceId` (notNull) with `agentId` (notNull) + `botId` (nullable); `agentId` is the stream grouping key, `botId` narrows to a specific bot when relevant
- `agents`: rename `goal` → `prompt`; drop `preset`; add `skillIds text[]`, `telegramChatId`, `executionMode`, `dailyTokenBudget`, `dailyLossLimit`, `maxBots`, `maxSlippageBps`
- `bots`: drop `strategyId`, `configVersion`, `uq_bots_active_venue_account` constraint; add FK from `venueAccountId` → `venue_accounts ON DELETE RESTRICT`
- `credentials` → rename table to `user_credentials` (no column changes)
- All child tables (`decisions`, `orders`, `fills`, `positions`, `execution_plans`, `journal_events`, `decision_contexts`, `reconciliation_events`): drop `tradingInstanceId`
  - `decisions`, `orders`, `fills`, `execution_plans`, `decision_contexts`: add `actorType`, `actorId`, `venueAccountId`
  - `positions`: add `actorType`, `actorId`; replace `idx_positions_open` with two indexes: `idx_positions_actor (actorType, actorId)` + `idx_positions_venue_symbol (venueAccountId, symbol)`
  - `journal_events`: add `actorType`, `actorId` (venueAccountId NOT added — payload JSONB carries it)
  - `reconciliation_events`: drop `tradingInstanceId` only (venueAccountId already present)
- New table: `skills` (full schema, system skills seeded only for MVP)
- New table: `agent_credentials` (agent-scoped references to `user_credentials`; cascade-deleted with agent)

See [005-target-db-schema.md](./005-target-db-schema.md) for the complete schema with all column definitions.

File: `packages/domain/src/values/ids.ts`
- Rename `TradingInstanceId` → `BotId`

File: `packages/domain/src/config/schema.ts`
- Rename `TradingInstanceConfigSchema` → `BotConfigSchema`
- Rename `TradingInstanceConfig` → `BotConfig`

File: `packages/domain/src/agent-protocol.ts`
- Rename `tradingInstanceId` field → `botId` in the protocol schema (keep backward-compat note)

#### 2c. DB repositories and helpers

`packages/db/src/` — rename all occurrences:
- `trading_instance_id` column references → `bot_id`
- `tradingInstanceId` variables → `botId`
- `tradingInstances` table reference → `bots`
- Remove all `agent_instance_links` / `agentInstanceLinks` references (table is dropped)
- Remove all `portfolios` / `portfolioId` / `PortfolioId` references (table and column dropped)
- Add query helpers: `getBotsByCreator(creatorType, creatorId)`, `countRunningBotsByCreator(creatorType, creatorId)`

#### 2d. Worker

`apps/worker/src/runtime.ts`:
- Rename `InstanceActor` → `BotActor`
- Rename `ActorFactory` → `BotActorFactory`
- Rename `InstanceLoader` → `BotLoader`
- Rename `PersistedInstance` → `PersistedBot`
- Rename `InstanceLease` → `BotLease` (in `instance-lease.ts`)
- Update all internal method names: `startInstance` → `startBot`, `stopInstance` → `stopBot`
- Update all `tradingInstanceId` parameter names → `botId`

Redis stream keys must be re-keyed from `tradingInstanceId` to `agentId` **in the same commit as the DB rename** — if these diverge, messages route silently to keys nobody is listening on:
- `apps/worker/src/agents/agent-runtime-launcher.ts`: `agent:inbound:{tradingInstanceId}` → `agent:inbound:{agentId}`
- `apps/worker/src/agents/agent-stream-consumer.ts`: same
- `apps/worker/src/agents/instance-event-publisher.ts` (rename to `bot-event-publisher.ts`): `agent:outbound:{tradingInstanceId}` → `agent:outbound:{agentId}`
- `apps/worker/src/agents/agent-reconnect-handler.ts`: same

#### 2e. API routes

`apps/api/src/routes/` — there is currently a route file for instances. Rename to `bots.ts`, update all route paths from `/instances` to `/bots`, update all handler variable names.

Update `apps/api/src/routes/agents.ts` — update `tradingInstanceId` references → `botId`.

#### 2f. Web UI

`apps/web/src/features/` — rename the instances feature folder and all component names:
- `/instances` page → `/bots` page
- `InstancesPage` → `BotsPage`
- `InstanceDetailPage` → `BotDetailPage`
- Update all route paths in the router
- Update the nav link label from "Instances" to "Bots"

Update `apps/web/src/lib/api-client.ts` — rename `instances` namespace → `bots`, update all endpoint paths.

---

### 3. Correct Agent Presets To Skill-Based Presets

**Problem:** `apps/api/src/routes/agents.ts` currently defines agent presets as `momentum_trader`, `range_trader`, `dca_accumulator`. These are trading strategy concepts and belong on bots, not agents.

**Correct model:** Agent presets are skill bundles. Bot blueprints carry strategy presets.

#### 3a. Change agent presets

File: `apps/api/src/routes/agents.ts`

Replace current `PRESET_IDS` and `PRESET_DEFAULTS` with skill-based presets:

| Preset | Description | Capabilities unlocked |
|---|---|---|
| `trading` | Trading-focused agent with market access | `decision_submit`, `web_fetch`, `send_message` |
| `reminder` | Scheduled notification agent | `send_message`, scheduled tool access |
| `custom` | User-defined capability bundle | None by default — user configures |

The `toolPolicy` bundled with each preset must reflect skills, not strategy params. Strategy params belong in the bot blueprint config.

#### 3b. Update the web UI create-agent flow

`apps/web/src/features/agents/` — update the preset selector to show skill-based presets with descriptions ("Trades on your behalf", "Sends reminders and alerts", "Custom skill bundle").

#### 3c. Add strategy presets to bot blueprint creation

`apps/api/src/routes/bots.ts` (renamed from instances) — add a `strategyPreset` field to the bot creation request:

| Preset | Description |
|---|---|
| `momentum` | Momentum-following strategy |
| `dca` | Dollar-cost averaging accumulation |
| `range` | Range-bound mean-reversion |

When a strategy preset is selected, populate default `strategyId` and `config` values accordingly.

---

### 4. Document And Enforce Agent Lifecycle Authority

An agent must be able to create, start, stop, reconfigure, and delete its own bots without user confirmation. An agent may run multiple bots simultaneously.

#### 4a. Add `manage_bot` to capability grants

File: `apps/worker/src/agents/capability-policy.ts`

Add a `manage_bot` capability to `DEFAULT_CAPABILITY_GRANTS` for the `trading` skill preset:
```ts
{
  capability: 'manage_bot',
  tier: 'brokered',
  enabled: true,
  limits: { maxPerMinute: 20, maxConcurrent: 5, timeoutMs: 15_000 },
},
```

This covers create, start, stop, reconfigure, and delete bot operations initiated by the agent.

#### 4b. Remove user-confirmation gates from agent bot lifecycle

Any existing code path that requires user approval before an agent-initiated bot start/create must be removed or made opt-in. The agent acts autonomously. User confirmation is not required by default.

#### 4c. Enforce tenancy boundary

The broker must verify that the `botId` targeted by any `manage_bot` action belongs to the same user as the agent. Reject with an explicit error if not.

#### 4d. Add `maxBotsPerAgent` operator config

File: `config/default.yaml` and `packages/domain/src/config/schema.ts`

Add:
```yaml
agents:
  maxBotsPerAgent: 5   # max concurrently running bots per agent
```

The broker must check `countRunningBotsByCreator('agent', agentId)` against this limit before allowing a `manage_bot` create or start action. Return a clear error when the limit is reached. The limit is purely resource/budget protection — it is not a policy constraint over agent autonomy.

---

### 5. Complete MVP Capability Gaps

#### 4a. Register `send_message` in `DEFAULT_CAPABILITY_GRANTS`

File: `apps/worker/src/agents/capability-policy.ts`

Add:
```ts
{
  capability: 'send_message',
  tier: 'brokered',
  enabled: true,
  limits: { maxPerMinute: 10, maxConcurrent: 5, timeoutMs: 10_000, maxResponseBytes: 4096 },
},
```

#### 4b. Broker reads persisted `toolPolicy`

File: `apps/worker/src/agents/agent-message-broker.ts`

`handleSendMessage` must read `agent.toolPolicy?.send_message?.maxPerMinute` and use it as the effective rate limit, falling back to the capability grant default. The hardcoded `SEND_MESSAGE_MAX_PER_MINUTE` constant must not be the final authority when a persisted override exists.

#### 4c. Complete safety alert wiring

File: `apps/worker/src/agents/agent-session-manager.ts`

The session manager currently fires only `runtime_failed` and `runtime_unhealthy`. Add emission for:
- `paused_by_guardrail` — when the agent is paused by a platform safety rule
- `critical_execution_failure` — when a reconciliation or execution failure requires operator attention

Reference the existing `platform-alert-service.ts` event types and wire the missing call sites.

---

### 5. Complete UI Gaps

#### 5a. Recent Decisions card on `AgentDetailPage`

Add `GET /agents/:id/decisions` to `apps/api/src/routes/agents.ts`:
- Query `decisions` where `actorType = 'agent'` and `actorId = agentId` directly — no bot or link lookup needed
- Order by `createdAt` desc, limit 10
- Return `id`, `intent`, `targetSize`, `limitPrice`, `instrumentId`, `createdAt`

Add to `apps/web/src/lib/api-client.ts`:
```ts
decisions: (id: string, limit?: number) => request<AgentDecision[]>(...)
```

Add "Recent Decisions" card to `AgentDetailPage` showing `intent`, `instrumentId`, `targetSize`, relative timestamp. Empty state: "No decisions submitted yet."

#### 5b. Objective progress card on `AgentDetailPage`

Add a minimal "Objective" card to `AgentDetailPage` containing:
- `prompt` text as the agent's stated mission
- Elapsed active time
- Current status summary

#### 5c. Delete control in `AgentDetailPage`

The delete API endpoint exists (`agents.ts`). Wire it in the UI:
- "Delete" button — confirmation dialog, then calls delete endpoint. Stops any running container first.

#### 5d. Fix UI naming and placeholders

- `/instances` page → `/bots` page with "New Bot" / "Create Bot" button. This is a **secondary surface** — bots created by agents are visible through the agent detail page. The `/bots` page exists for power users who want to inspect or manually create bots directly. It is not a primary navigation item and should not be presented as an equal peer to `/agents` in the main nav.
- `/agents` page — "New Agent" / "Create Agent" button (no change, this is correct)
- Agent create form: replace hardcoded `"My BTC Agent"` placeholder → `"<username>-agent"` (resolved from the authenticated user's username at render time)

#### 5e. Agent create form fields

The agent creation form collects:

**Required:**
- `name` — agent name (placeholder: `<username>-agent`)
- `prompt` — free-text goal / instructions (e.g. "Trade crypto on Hyperliquid. Grow my portfolio. Here is my API key: ...")
- `telegramChatId` — Telegram chat ID for agent-authored messages and platform safety alerts
- `skillPreset` — skill bundle: `trading` | `reminder` | `custom`

**Optional (with sensible defaults):**
- `llmModel` — which LLM to use (default from operator config)
- `venueInfo` — wallet address or API key; if not provided here, the agent will ask via `send_message`
- `executionMode` — `paper` | `shadow` | `live` (default: `paper`)

**Guard rails** (these are operational constraints, not agent policy restrictions):
- `dailyTokenBudget` — max LLM tokens per day (default from subscription plan)
- `dailyLossLimit` — max loss in USD/base currency per day before agent auto-stops (optional). **Enforcement owner:** the broker checks cumulative session P&L before processing each `decision_submit`. If the limit is breached, the decision is rejected and the agent is paused. This is a user-configured constraint — it is enforced because the user set it, not as a platform default.
- `maxBots` — inferred from subscription plan; operator cap is `agents.maxBotsPerAgent`
- `maxSlippageBps` — max acceptable slippage in basis points (optional; relevant for live/shadow modes)

The agent infers venue type, instruments, and strategy from the prompt and venue info. If the prompt is ambiguous, the agent asks via `send_message` before acting. No symbol entry, no strategy selection, no technical venue config is required from the user.

---

## Exit Criteria

- [ ] All DB, domain, worker, API, and web references use `bot` / `botId` / `bots`
- [ ] `agent_instance_links` table dropped; `bots` table has `creatorType` + `creatorId` columns
- [ ] `credentials` table renamed to `user_credentials`
- [ ] All child tables have `tradingInstanceId` dropped; actor-tracked tables have `actorType`/`actorId` added
- [ ] `decisions`, `orders`, `fills`, `execution_plans`, `decision_contexts` have `venueAccountId` added
- [ ] `positions` has `idx_positions_actor` and `idx_positions_venue_symbol` indexes replacing `idx_positions_open`
- [ ] `skills` table created and system skills seeded
- [ ] `agent_credentials` table created
- [ ] `agents.preset` dropped; `agents.skill_ids text[]` added
- [ ] Drizzle migrations wiped and regenerated from scratch
- [ ] Agent presets are skill-based (`trading`, `reminder`, `custom`)
- [ ] Strategy presets are on bot blueprint creation
- [ ] `send_message` registered in `DEFAULT_CAPABILITY_GRANTS`
- [ ] Broker reads persisted `toolPolicy` for `send_message`
- [ ] Safety alerts fire for all four mandatory event types
- [ ] Recent Decisions card visible in `AgentDetailPage`
- [ ] Objective card visible in `AgentDetailPage`
- [ ] Delete control wired in `AgentDetailPage` (no relink)
- [ ] `/bots` page has "Create Bot" button; `/agents` page has "Create Agent" button
- [ ] Agent name placeholder uses `<username>-agent`
- [ ] Agent create form collects: name, prompt, telegramChatId, skillPreset, optional llmModel/venueInfo/executionMode/guardRails
- [ ] `pnpm lint` passes
- [ ] All existing tests pass

---

## Decision Log

Append-only. Record decisions made or changed during implementation, with date and reason.

| Date | Decision | Reason |
|---|---|---|
| 2026-06-04 | Drop `agent_instance_links` table; use `creatorType`/`creatorId` on `bots` | Agents create bots autonomously; a link table implies independent pre-existing entities being joined, which is wrong |
| 2026-06-04 | Wipe Drizzle migrations and regenerate from scratch | No backward compat needed; cleaner than incremental migration on a broken model |
| 2026-06-04 | Remove "relink" concept entirely | With `creatorId` model, there is no link to relink; bots belong to their creator |
| 2026-06-04 | Agent presets are skill-based, not strategy-based | Strategy presets belong on bot blueprints; agents are not trading strategies |
| 2026-06-05 | DB schema written and reviewed before any code changes | Schema touches every layer; review first prevents mid-implementation rework |
| 2026-06-05 | `portfolioId` on `bots` is nullable | Not all bots require a portfolio; making it required was overly restrictive |
| 2026-06-05 | `agent_runtime_sessions.tradingInstanceId` dropped | Sessions are agent-scoped; one container manages all agent bots |
| 2026-06-05 | `agent_messages`: `tradingInstanceId` → `agentId` (notNull) + `botId` (nullable) | `tradingInstanceId` was a proxy for "which session" requiring link table resolution; `agentId` is direct |
| 2026-06-05 | Session guard `UNIQUE (agent_id) WHERE active` migrated from link table to `agent_runtime_sessions` | Dropping the link table without migrating this constraint would leave a race window for duplicate active sessions |
| 2026-06-05 | Redis stream keys re-keyed from `tradingInstanceId` to `agentId` | Stream keys must change in same commit as DB rename or messages route to dead keys silently |
| 2026-06-05 | `tradingInstanceId` dropped from ALL child tables entirely (Q15–Q16) | Agents can trade directly without a bot; any column named `tradingInstanceId`/`botId` would falsely assume execution always requires a bot |
| 2026-06-05 | Child tables use `actorType`+`actorId`+`venueAccountId` instead of `botId` (Q16) | Separates who acted (actor) from where they acted (venue account); supports agent-direct and bot-mediated execution uniformly |
| 2026-06-05 | Risk gate checks total exposure per `(venueAccountId, symbol)` across ALL actors (Q21) | Venue sees net position; herobids must reflect the same or the risk gate would allow oversized combined exposure |
| 2026-06-05 | `positions` gets two indexes: per-actor + per-venue-symbol (Q22) | One index serves per-actor queries; a separate index serves the risk gate's aggregate exposure query — a composite index would serve neither well |
| 2026-06-05 | `credentials` renamed to `user_credentials` (Q20) | Makes ownership model explicit alongside `agent_credentials`; removes ambiguity about which table is which |
| 2026-06-05 | `agents.preset` → `skillIds text[]`; preset concept lives only in UI (Q5) | Skills are composable; preset is a UI convenience; storing a preset string in DB prevents composition |
| 2026-06-05 | `skills` and `agent_credentials` tables created in Phase 1 (Q12) | Phase 2 runtime reads them at tick time; they must exist before any agent runtime code lands |
| 2026-06-05 | Catch-up audit: steps 1.2–1.10, 1.13 marked done/partial after discovering implementation ran ahead of plan | Plan was not updated during implementation; audit performed retroactively per `000a-how-to-implement.md` Catch-up Audit procedure |
| 2026-06-07 | Skills CRUD API (`GET/POST/PUT/DELETE /skills`, fork) completed in feature 017 — step 1.2 `skills` table fully surfaced at API layer | Skills table was created in migrations as part of Phase 1; API surface deferred and landed alongside analytics/AI work |
