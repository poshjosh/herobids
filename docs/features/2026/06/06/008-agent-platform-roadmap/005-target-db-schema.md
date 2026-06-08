# Target DB Schema — Phase 1

Authoritative final schema. All decisions resolved through Q&A (Q1–Q22).
Wipe existing migrations and regenerate from this.

---

## Tables: Changes

### 1. `trading_instances` → `bots`

Remove: `portfolioId`, `strategyId`, `configVersion`, `uq_trading_instances_active_venue_account` constraint.
Add: `creatorType`, `creatorId`. Change: `venueAccountId` → FK to `venue_accounts` ON DELETE RESTRICT.

```ts
export const bots = pgTable('bots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  // portfolioId REMOVED — no MVP benefit; user thinks in wallets/accounts
  // strategyId REMOVED — redundant with config.strategy.type
  // configVersion REMOVED — no consumer; use updatedAt as ETag
  venueAccountId: text('venue_account_id').notNull()
    .references(() => venueAccounts.id, { onDelete: 'restrict' }),   // FK added
  /** Strategy params, risk overrides, execution mode. config.strategy.type is the strategy discriminator. */
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  /** stopped | running | crashed */
  status: text('status').notNull().default('stopped'),
  /** Who created this bot: agent | user | system */
  creatorType: text('creator_type').notNull().default('user'),
  /** agentId if creatorType=agent; userId if creatorType=user; null if system */
  creatorId: text('creator_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_bots_user_id').on(t.userId),
  index('idx_bots_status').on(t.status),
  index('idx_bots_creator_id').on(t.creatorId),
  index('idx_bots_venue_account_id').on(t.venueAccountId),
  // uq_trading_instances_active_venue_account REMOVED
  // Replaced by runtime broker check: agents.maxBotsPerVenueAccount (operator config)
]);
```

---

### 2. `agents`

Remove: `preset`.
Rename: `goal` → `prompt`.
Add: `skillIds text[]`, `telegramChatId`, `executionMode`, guard rail fields.

```ts
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  /** High-level goal injected into every agent prompt tick */
  prompt: text('prompt').notNull(),                          // was: goal
  // preset REMOVED — replaced by skillIds text[]
  /** Ordered list of skill IDs. base skill auto-injected at runtime, not stored. */
  skillIds: text('skill_ids').array().notNull().default(sql`'{}'::text[]`),
  /** stopped | starting | active | paused | crashed */
  status: text('status').notNull().default('stopped'),
  pauseState: jsonb('pause_state').$type<{ reason: string; requestedBy: string; pausedAt: string } | null>(),
  toolPolicy: jsonb('tool_policy').$type<Record<string, unknown>>(),
  modelPolicy: jsonb('model_policy').$type<Record<string, unknown>>(),
  /** Telegram chat ID for send_message and safety alert delivery */
  telegramChatId: text('telegram_chat_id'),
  /** Execution mode for bots this agent creates: paper | shadow | live */
  executionMode: text('execution_mode'),
  /** Guard rails — broker-enforced, user-configured */
  dailyTokenBudget: integer('daily_token_budget'),           // max LLM tokens/day
  dailyLossLimit: numeric('daily_loss_limit'),               // max cumulative P&L loss/day (USD)
  maxBots: integer('max_bots'),                              // max concurrent bots (agent-level override)
  maxSlippageBps: integer('max_slippage_bps'),               // max slippage in basis points
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agents_user_id').on(t.userId),
  index('idx_agents_status').on(t.status),
]);
```

---

### 3. `agent_instance_links` → **DROP**

The table conflated two concerns:
1. **Relationship** — now expressed by `bots.creatorType`/`creatorId`
2. **Session guard** — `UNIQUE (agent_id) WHERE status = 'active'` → migrated to `agent_runtime_sessions` (see §4)

No remaining concept requires this table.

---

### 4. `agent_runtime_sessions`

Remove: `tradingInstanceId`.
Add: `UNIQUE (agentId) WHERE status NOT IN ('stopped', 'crashed')` — session guard migrated from `agent_instance_links`.

```ts
export const agentRuntimeSessions = pgTable('agent_runtime_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  // tradingInstanceId REMOVED — sessions are agent-scoped; one container manages all agent bots
  /** starting | running | unhealthy | stopped | crashed */
  status: text('status').notNull().default('starting'),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  cpuPct: integer('cpu_pct'),
  memoryBytes: integer('memory_bytes'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_agent_runtime_sessions_agent_id').on(t.agentId),
  index('idx_agent_runtime_sessions_status').on(t.status),
  // Replaces UNIQUE (agent_id) WHERE status='active' from agent_instance_links.
  // Prevents two concurrent active/starting/unhealthy sessions for the same agent.
  uniqueIndex('uq_agent_runtime_sessions_active_agent')
    .on(t.agentId)
    .where(sql`${t.status} NOT IN ('stopped', 'crashed')`),
]);
```

---

### 5. `agent_messages`

Remove: `tradingInstanceId`.
Add: `agentId` (not null — primary grouping key), `botId` (nullable — narrows to a specific bot).

```ts
export const agentMessages = pgTable('agent_messages', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().unique(),
  correlationId: text('correlation_id').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  agentId: text('agent_id').notNull(),   // REPLACES tradingInstanceId — stream grouping key
  botId: text('bot_id'),                 // nullable — set when message is bot-scoped
  type: text('type').notNull(),
  direction: text('direction').notNull(),
  schemaVersion: text('schema_version').notNull().default('v1'),
  sequence: integer('sequence'),
  traceId: text('trace_id'),
  processingStatus: text('processing_status').notNull().default('received'),
  errorDetail: jsonb('error_detail').$type<{ code: string; message: string } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_messages_agent_id').on(t.agentId),
  index('idx_agent_messages_bot_id').on(t.botId),
  index('idx_agent_messages_correlation_id').on(t.correlationId),
  index('idx_agent_messages_type').on(t.type),
  index('idx_agent_messages_actor_id').on(t.actorId),
  index('idx_agent_messages_created_at').on(t.createdAt),
]);
```

---

### 6. `credentials` → `user_credentials`

Rename table only. No column changes.

```ts
export const userCredentials = pgTable('user_credentials', {
  // all columns unchanged from credentials
  id, userId (FK → users), venue, label, encryptedData, encryptionMeta, createdAt, updatedAt
});
```

---

### 7. `portfolios` → **DROP**

No MVP benefit. User thinks in wallets and accounts.
Remove: schema file, `index.ts` export, `PortfolioId` from domain ids, all API schemas and web form state, `checkPortfolioLimit` from plan-guards, `portfolioRoutes` from API.

---

### 8. `decisions`

Remove: `tradingInstanceId`.
Add: `venueAccountId`.
Keep: `actorType`, `actorId` (already present).

```ts
export const decisions = pgTable('decisions', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED
  venueAccountId: text('venue_account_id').notNull(),   // execution context
  instrumentId: text('instrument_id').notNull(),
  intent: text('intent').notNull(),
  targetSize: numeric('target_size').notNull(),
  limitPrice: numeric('limit_price'),
  contextHash: text('context_hash'),
  actorType: text('actor_type').notNull().default('system'),   // agent | bot | user | system
  actorId: text('actor_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decisions_venue_account_id').on(t.venueAccountId),
  index('idx_decisions_actor_type').on(t.actorType),
  index('idx_decisions_actor_id').on(t.actorId),
  index('idx_decisions_created_at').on(t.createdAt),
]);
```

---

### 9. `orders`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`, `venueAccountId`.

```ts
export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED
  venueAccountId: text('venue_account_id').notNull(),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  executionPlanId: text('execution_plan_id'),
  venueRefId: text('venue_ref_id'),
  clientOrderId: text('client_order_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  type: text('type').notNull(),
  quantity: numeric('quantity').notNull(),
  price: numeric('price'),
  status: text('status').notNull().default('pending'),
  filledQuantity: numeric('filled_quantity').notNull().default('0'),
  avgFillPrice: numeric('avg_fill_price'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_orders_venue_account_id').on(t.venueAccountId),
  index('idx_orders_actor_id').on(t.actorId),
  index('idx_orders_venue_ref_id').on(t.venueRefId),
  index('idx_orders_status').on(t.status),
]);
```

---

### 10. `fills`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`, `venueAccountId`.

```ts
export const fills = pgTable('fills', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED
  orderId: text('order_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  venueRefId: text('venue_ref_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  quantity: numeric('quantity').notNull(),
  price: numeric('price').notNull(),
  fee: numeric('fee'),
  feeCurrency: text('fee_currency'),
  filledAt: timestamp('filled_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_fills_order_id').on(t.orderId),
  index('idx_fills_venue_account_id').on(t.venueAccountId),
  index('idx_fills_actor_id').on(t.actorId),
  index('idx_fills_filled_at').on(t.filledAt),
]);
```

---

### 11. `positions`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`.
Replace `idx_positions_open` on `(tradingInstanceId, closedAt)` with two separate indexes.

```ts
export const positions = pgTable('positions', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED
  venueAccountId: text('venue_account_id').notNull(),   // already present
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  size: numeric('size').notNull(),
  entryPrice: numeric('entry_price').notNull(),
  realizedPnl: numeric('realized_pnl').notNull().default('0'),
  markSource: text('mark_source'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_positions_venue_account_id').on(t.venueAccountId),
  index('idx_positions_actor').on(t.actorType, t.actorId),               // per-actor queries
  index('idx_positions_venue_symbol').on(t.venueAccountId, t.symbol),    // risk gate: total exposure
  // idx_positions_open REMOVED — replaced by above + WHERE closedAt IS NULL filter
]);
```

> **Risk gate query:** `WHERE venueAccountId = ? AND symbol = ? AND closedAt IS NULL` sums exposure across ALL actors on the same venue account and symbol. The venue sees net position; herobids must match it.

---

### 12. `execution_plans`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`, `venueAccountId`.

```ts
export const executionPlans = pgTable('execution_plans', {
  id: text('id').primaryKey(),
  decisionId: text('decision_id').notNull(),
  // tradingInstanceId REMOVED
  venueAccountId: text('venue_account_id').notNull(),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  venue: text('venue').notNull(),
  symbol: text('symbol').notNull(),
  action: text('action').notNull(),
  plannedOrders: jsonb('planned_orders').notNull().$type<unknown[]>(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('idx_execution_plans_decision_id').on(t.decisionId),
  index('idx_execution_plans_venue_account_id').on(t.venueAccountId),
  index('idx_execution_plans_actor_id').on(t.actorId),
]);
```

---

### 13. `journal_events`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`.
Note: `venueAccountId` NOT added — the payload JSONB carries it for relevant event types.

```ts
export const journalEvents = pgTable('journal_events', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED
  actorType: text('actor_type'),   // nullable — some system events have no actor
  actorId: text('actor_id'),
  backtestRunId: text('backtest_run_id'),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_journal_events_actor_id').on(t.actorId),
  index('idx_journal_events_type').on(t.type),
  index('idx_journal_events_created_at').on(t.createdAt),
  index('idx_journal_events_backtest_run_id').on(t.backtestRunId),
]);
```

---

### 14. `decision_contexts`

Remove: `tradingInstanceId`.
Add: `actorType`, `actorId`, `venueAccountId`.

```ts
export const decisionContexts = pgTable('decision_contexts', {
  id: text('id').primaryKey(),
  decisionId: text('decision_id').notNull(),
  // tradingInstanceId REMOVED
  venueAccountId: text('venue_account_id').notNull(),
  actorType: text('actor_type').notNull().default('system'),
  actorId: text('actor_id'),
  contextHash: text('context_hash').notNull(),
  context: jsonb('context').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decision_contexts_decision_id').on(t.decisionId),
  index('idx_decision_contexts_context_hash').on(t.contextHash),
  index('idx_decision_contexts_venue_account_id').on(t.venueAccountId),
  index('idx_decision_contexts_actor_id').on(t.actorId),
]);
```

---

### 15. `reconciliation_events`

Remove: `tradingInstanceId` only. `venueAccountId` already present.

```ts
export const reconciliationEvents = pgTable('reconciliation_events', {
  id: text('id').primaryKey(),
  // tradingInstanceId REMOVED — reconciliation is venue-account-scoped, not actor-scoped
  venueAccountId: text('venue_account_id').notNull(),
  result: text('result').notNull(),
  localState: jsonb('local_state').notNull().$type<Record<string, unknown>>(),
  venueState: jsonb('venue_state').notNull().$type<Record<string, unknown>>(),
  diff: jsonb('diff').notNull().$type<Array<Record<string, unknown>>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_reconciliation_events_venue_account_id').on(t.venueAccountId),
  index('idx_reconciliation_events_created_at').on(t.createdAt),
  index('idx_reconciliation_events_result').on(t.result),
]);
```

---

### 16. No changes: `llm_decision_artifacts`, `agent_artifacts`

- `llm_decision_artifacts` chains via `decisionId` — no `tradingInstanceId`, no changes needed.
- `agent_artifacts` is already agent-scoped — no `tradingInstanceId`, no changes needed.

---

## Tables: New

### 17. `skills`

Full marketplace schema, system skills seeded only for MVP.

```ts
export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  /** null = system-owned; userId = user-authored */
  authorId: text('author_id').references(() => users.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** Instructions injected into the agent prompt when this skill is active */
  instructions: text('instructions').notNull(),
  /** Tools this skill exposes to the agent */
  requiredTools: text('required_tools').array().notNull().default(sql`'{}'::text[]`),
  /** Context sections required in the prompt: positions, analytics, bot_statuses, etc. */
  contextRequirements: text('context_requirements').array().notNull().default(sql`'{}'::text[]`),
  /** Guardrail IDs this skill requires: token-budget, daily-loss, bot-limit */
  requiredGuardrails: text('required_guardrails').array().notNull().default(sql`'{}'::text[]`),
  /** Suggested tick interval in ms (0 = no suggestion) */
  suggestedTickIntervalMs: integer('suggested_tick_interval_ms').default(900_000),
  /** public | private */
  visibility: text('visibility').notNull().default('private'),
  tags: text('tags').array().default(sql`'{}'::text[]`),
  /** Self-referencing FK for fork lineage */
  forkOf: text('fork_of').references((): AnyPgColumn => skills.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_skills_author_id').on(t.authorId),
  index('idx_skills_visibility').on(t.visibility),
]);
```

**MVP seeded skills** (authorId = null):
- `bot-management` — create/start/stop/monitor bots; tools: `create_bot`, `stop_bot`, `start_bot`, `list_bots`, `get_bot_status`, `adjust_bot_config`, `register_credential`, `search_instruments`
- `risk-monitoring` — watch positions, alert on drawdowns; tools: `list_positions`, `get_analytics`, `send_message`
- `trade-review` — analyze closed trades; tools: `get_analytics`, `get_journal_summary`, `write_memory`

**Runtime-injected (not in DB):**
- `base` — memory, messaging, costs; auto-injected into every agent at tick time

**UI preset → skillIds mapping** (convenience layer, not stored in DB):
- `trading` → `skillIds = ['bot-management']`
- `reminder` → `skillIds = ['risk-monitoring']`
- `custom` → `skillIds = []`

---

### 18. `agent_credentials`

Agent-scoped credential references. Cascade-deleted with the agent.

```ts
export const agentCredentials = pgTable('agent_credentials', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull()
    .references(() => userCredentials.id, { onDelete: 'restrict' }),
  /** Human-readable label: "hyperliquid_main", "twitter_api", etc. */
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_credentials_agent_id').on(t.agentId),
]);
```

---

## Config Changes

### `config/default.yaml`

```yaml
plans:
  free:
    maxBots: 5              # was: maxTradingInstances
    maxVenueAccounts: 5
    maxCredentials: 5       # scopes to user_credentials
    maxAgents: 5
    # maxPortfolios REMOVED

agents:
  maxBotsPerAgent: 5          # operator safety cap — one agent can't create unbounded bots
  maxBotsPerVenueAccount: 1   # replaces dropped DB unique constraint; raise to allow multi-bot accounts
```

### `apps/api/src/plan-guards.ts`

- Remove `checkPortfolioLimit`
- Rename `checkTradingInstanceLimit` → `checkBotLimit` (queries `bots` table)
- Rename `PlanLimits.maxTradingInstances` → `maxBots`
- Remove `PlanLimits.maxPortfolios`

---

## Redis Stream Keys

Stream keys currently keyed by `tradingInstanceId` — re-keyed to `agentId` in the same commit as the DB rename.

| Current | Target |
|---|---|
| `agent:inbound:{tradingInstanceId}` | `agent:inbound:{agentId}` |
| `agent:outbound:{tradingInstanceId}` | `agent:outbound:{agentId}` |

Files:
- `apps/worker/src/agents/agent-runtime-launcher.ts`
- `apps/worker/src/agents/agent-stream-consumer.ts`
- `apps/worker/src/agents/instance-event-publisher.ts` → rename to `bot-event-publisher.ts`
- `apps/worker/src/agents/agent-reconnect-handler.ts`

---

## Repository Method Changes

**`positions` repository:**
- `getOpenByInstance(tradingInstanceId)` → `getOpenByActor(actorType, actorId)`
- `getAllByInstance(tradingInstanceId)` → `getAllByActor(actorType, actorId)`
- `getAllByPortfolio` / `getOpenByPortfolio` → DELETE (portfolios gone)
- ADD: `getOpenByVenueAndSymbol(venueAccountId, symbol)` — risk gate aggregate query

**`agent_runtime_sessions` repository:**
- `getSessionForAgentAndInstance(agentId, tradingInstanceId)` → `getActiveSession(agentId)`
- `getActiveSessionByInstance(tradingInstanceId)` → `getActiveSession(agentId)`

**`bots` repository (new, was `trading_instances`):**
- ADD: `getBotsByCreator(creatorType, creatorId)`
- ADD: `countRunningBotsByCreator(creatorType, creatorId)`

---

## Decisions

| # | Decision | Resolution |
|---|---|---|
| Q1 | `bots.venueAccountId` required at creation; FK enforced | Agreed — FK `ON DELETE RESTRICT`; bot creation is the commitment point |
| Q2 | `venue_accounts` stays, auto-managed by agents | Agreed — engine needs stable `venueAccountId` across positions/fills/reconciliation |
| Q3 | Credential from agent prompt: agent extracts via `register_credential` tool | Agreed — platform encrypts; prompt scrubbed after; user path still available |
| Q4 | Two credential attachment points: `user_credentials` + `agent_credentials` | Agreed |
| Q5 | `agents.skillIds text[]` replaces `agents.preset text` | Agreed — composable; preset concept lives in UI only |
| Q6 | Full `skills` table schema now; seed system skills only for MVP | Agreed — bot-management, risk-monitoring, trade-review seeded; base injected at runtime |
| Q7 | Agent resolves `symbol` and `venue` via `search_instruments` tool; broker validates | Agreed — agent-first; broker does not guess |
| Q8 | `strategyId` dropped as top-level column; `config.strategy.type` is sole source of truth | Agreed |
| Q9 | `register_credential` atomically creates both `user_credentials` + `venue_account` rows | Agreed; paper bots call `create_venue_account` directly without credential |
| Q10 | `uq_bots_active_venue_account` DB constraint dropped; replaced by `maxBotsPerVenueAccount` config | Agreed |
| Q11 | `configVersion` dropped; no consumer; use `updatedAt` as ETag if needed | Agreed |
| Q12 | `skills` + `agent_credentials` tables created in Phase 1 migration | Agreed — Phase 2 runtime depends on them |
| Q13 | Two bot limits: `maxBots` (plan-level) + `maxBotsPerAgent` (operator-level) | Agreed |
| Q14 | Billing tables stay; `instruments` table stays unpopulated until Phase 2 | Agreed |
| Q15–Q16 | `tradingInstanceId`/`botId` dropped from all child tables; replaced by `actorType`/`actorId` + `venueAccountId` | Agreed — agents can trade directly; no structural assumption that execution requires a bot |
| Q17 | `execution_plans` and `decision_contexts`: denormalize `actorType`/`actorId`/`venueAccountId` directly | Agreed — avoids join through decisions |
| Q18 | `bots.venueAccountId` FK `ON DELETE RESTRICT` | Agreed — can't delete venue account under a running bot |
| Q19 | `config.venue` and `config.venueType` stay in JSONB | Agreed — engine reads without join; FK ensures consistency |
| Q20 | `credentials` renamed to `user_credentials` | Agreed — makes ownership model explicit alongside `agent_credentials` |
| Q21 | Risk gate checks total exposure per `(venueAccountId, symbol)` across ALL actors | Agreed — venue sees net position; herobids must reflect the same |
| Q22 | `positions` gets two indexes: `idx_positions_actor` + `idx_positions_venue_symbol` (no `closedAt` in key) | Agreed |
