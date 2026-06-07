# Q and A

## Question 1

**Q1: Does a bot require a `venueAccountId` at creation time, or can it be created without one?**

Right now a bot's `venueAccountId` is `NOT NULL` with no FK to `venue_accounts`. The agent-first flow says: the agent infers the venue from the user's prompt or venue info, then creates the bot. But if the user hasn't set up a venue account yet, or if the agent is figuring it out via `send_message`, there's a gap.

**My recommendation: require it at creation time, FK enforced.**

Rationale: a bot without a venue account cannot do anything — it can't reconcile, can't submit orders, can't track positions. Creating one in a "pending" state adds a whole lifecycle state (`pending_venue`) that doesn't exist anywhere else. The cleaner model: the agent asks the user (via `send_message`) before creating the bot, gets the venue account confirmed, then creates the bot fully-formed. Bot creation is the commitment point, not an intermediate step.

This also means `bots.venueAccountId` should get an explicit FK to `venue_accounts` in the new schema — currently it has none.

Do you agree?

## Answer 1

- An agent can exist with no inclination/skill to trade or create bots. Always remember this.

- An agent does not need to create a bot to trade. In fact in the aitradingbot repo, we had a separate bot-management skill. Only agents who had that skill could create/manage bots. Agents which traded directly seemed to do better, but this needs more testing.

- An agent which has venue info, can pass it to its created bots. Does this mean there is no venue info table? Maybe. We are not trying to be a trading platform first. We are first an agentic platform, then next a skills platform and our core skill is trading. I am open to suggestions. For example, an agent could have a key-value map of info resolved from the prompt. That info goes away when the agent is deleted. In addition, users could create venues ... STOP - while this is ok, we would rather not focus on it now. The cost and legal requirements for being a trading platform is quite high. We want to be agentic first. Have a venue if you must have one or if removing it is quite complex. If you have a venue table, our agents must be able to automatically populate it. There may be other alternatives. Does this make sense?

## Question 2

**Q2: Should `venue_accounts` stay as a table, but auto-managed by the platform?**

Here's the landscape:

- `venue_accounts` is referenced by `bots`, `positions`, `balance_snapshots`, `reconciliation_events` — removing it is not trivial, the trading engine needs a stable identifier for "where is this bot executing"
- The user never needs to see or create a `venue_account` directly — the agent extracts venue info from the prompt and provisions it automatically
- aitradingbot handled this differently: no `venue_accounts` table, just a `walletId` on the bot config, and the agent passed it in when calling `create_bot`

**The practical question:** when an agent with the `bot-management` skill calls `create_bot`, where does the venue credential live?

Two options:

| Option | How it works |
|---|---|
| A (keep `venue_accounts`) | Agent auto-creates a `venue_account` row from the prompt. Bot gets `venueAccountId`. The table exists but is invisible to the user. |
| B (drop `venue_accounts`, inline on bot) | Bot has `venue: text` + `credentialId: text` directly. No join needed. Simpler schema. |

Option B is simpler and eliminates a table. The downside: if a user has multiple bots on the same Hyperliquid account, there is no shared record to update — you'd update each bot's credential reference separately. For the MVP with one bot per venue that's fine.

**My recommendation: keep `venue_accounts`, but make it auto-managed.** The engine already uses `venueAccountId` as a stable key across positions, reconciliation, and balance snapshots. If two bots share the same wallet, they share the same `venue_account` row and the engine correctly scopes their activity. Removing it would require denormalizing credentials into every table that currently references it.

The user-facing change: the "Add Venue Account" UI flow disappears. The agent creates it. The venue accounts list becomes a read-only view of what agents have provisioned.

Do you agree with keeping `venue_accounts` as auto-managed infrastructure?

## Answer 2

I agree with keeping `venue_accounts` as auto-managed infrastructure

## Question 3

**Q3: When a user includes an API key in their agent prompt, how does that key reach the trading skill safely?**

This is the most security-critical question in the whole design. Here's the problem:

The user writes: `"Trade crypto on Hyperliquid. Here's my API key: 0xabc123... secret: xyz..."`

That key is now sitting in the `agents.prompt` column in plaintext, visible to anyone with DB read access. The agent also repeats it in every LLM prompt tick — sending it to the LLM provider.

This is a real attack surface and the root reason the `credentials` table exists with encrypted-at-rest storage.

**Three options:**

| Option | Flow | Security posture |
|---|---|---|
| A — Agent extracts and registers | Agent calls a brokered `register_credential` tool with the extracted key. Platform encrypts and stores it. Agent's prompt is scrubbed after extraction. | Credential stored safely, but LLM saw the raw key at least once |
| B — User registers credential first, agent references it | UI still has a "Add Credential" step. Agent receives a `credentialId`, never the raw key. | Cleanest. Key never touches LLM. |
| C — Inline on bot config, no credential table | Agent passes the raw key in `create_bot` config JSON. Stored in `bots.config` JSONB, encrypted? | Messy, breaks the existing encrypted-at-rest model |

**My recommendation: Option A for the agent path, Option B still available for power users.**

The agent receives the key in the prompt (unavoidable if the user typed it there), extracts it via a brokered `register_credential` tool call, the platform encrypts and stores it, returns a `credentialId`, and from that point on the agent only knows the `credentialId`. The raw key never appears in subsequent ticks. The `prompt` field should be scrubbed of detected key patterns after registration — or the user should be warned via `send_message` not to embed keys in the prompt.

This keeps the `credentials` table but makes it agent-populatable, not just user-populatable.

Do you agree, or do you want a different approach to how the agent acquires venue credentials?

## Answer 3

I agree. Also, we should design to expect multiple credentials (e.g. at agent creation form) in the future. Remember agents are not limited to trading only.

## Question 4

**Q4: Should credentials be attachable to agents directly, or only to venue accounts (and bots inherit them via the venue account)?**

Current herobids model: `credentials` → referenced by `venue_accounts.credentialId` → referenced by `bots.venueAccountId`. A credential reaches a bot via the venue account.

The user said agents need multiple credentials in the future — not just trading (e.g. a Twitter key, a data API key, a webhook secret).

Two structural options:

| Option | Shape |
|---|---|
| A — Keep venue account as the bridge | Non-trading credentials live somewhere else (e.g. `agent_credentials` table: agentId + credentialId + label). Trading credentials stay on `venue_accounts`. Two different attachment points. |
| B — Unified `agent_credentials` attachment | All credentials attach to the agent directly. `venue_accounts.credentialId` becomes a reference to an agent-attached credential. The bot inherits via its `creatorId` (the agent). |

Option B is cleaner conceptually but changes how `venue_accounts` works — the credential is now agent-owned, not user-owned, which means if the agent is deleted, the credential goes too. That's probably correct for agent-provisioned credentials. For user-managed credentials (Option B power user path), they remain on the `credentials` table directly.

**My recommendation: Option A — two attachment points.**

- `credentials` table: user-managed, user-scoped. Encrypted at rest. Referenced by `venue_accounts`. Used by the trading engine.
- `agent_credentials` table: agent-scoped key-value store. `agentId`, `label` (e.g. `"twitter_api_key"`), `credentialId` FK to `credentials`. Deleted with the agent. Agent-provisioned credentials write to `credentials` first (encrypted), then link via `agent_credentials`.

This matches your earlier idea of "a key-value map of info resolved from the prompt that goes away when the agent is deleted" — except the values are credential references, not raw secrets.

For the MVP, `agent_credentials` doesn't need to be built — it's just important the schema doesn't preclude it. The trading path (user or agent provisions a credential → creates a venue account → creates a bot) stays unchanged.

Do you agree, or do you want to simplify further and just attach credentials directly to the agent for now?

## Answer 4

I agree. credentials could be user_credentials. venue_accounts is ok. agents_credentials is ok. 

An example: During agent creation, if there are existing user credentials, the user can select them. The user could also add new credentials/secret.

## Question 5

**Q5: Should `agents.skillPreset` be a single value or an array of skill IDs?**

aitradingbot uses `skillIds text[]` — an agent can have multiple skills simultaneously. For example: `['bot-management', 'risk-monitoring', 'base']`. The base skill is auto-injected at runtime and not stored. Each skill contributes its own tool list. The union of all skill tool lists is the agent's capability set.

Our current plan has `skillPreset text` with values `trading | reminder | custom`. That's a single preset that bundles a fixed tool list. This is simpler but less composable.

The practical tension:

| Model | Upside | Downside |
|---|---|---|
| Single `skillPreset` | Simple UI, easy defaults, easy to explain to laymen | An agent can't be "trading + risk-monitoring" without a new preset |
| `skillIds text[]` | Composable, maps directly to aitradingbot port | More complex UI, "what skills does this agent have?" is less obvious |

**My recommendation: `skillIds text[]` with UI abstraction.**

The DB stores the array. The create form presents named presets as shortcuts that map to a bundle of skill IDs — e.g. selecting `trading` preset automatically sets `skillIds = ['base', 'bot-management']`. Power users can customise via an "Advanced" toggle. This is exactly the aitradingbot pattern and it maps cleanly to the Phase 2 agent runtime port.

The `skillPreset` column gets dropped in favour of `skillIds text[]`. The "preset" concept lives in the UI and API as a convenience layer, not in the DB.

Do you agree?

## Answer 5

I agree

## Question 6

**Q6: Does the MVP need a full `skills` table (user-authored, forkable), or just seeded system skills?**

The `skills` table in aitradingbot is a full marketplace: `authorId` (null = system-owned, userId = user-authored), `visibility` (public/private), `forkOf` (fork lineage). Users can write their own skills and fork existing ones.

For the MVP, we need the table because the agent runtime reads `instructions`, `requiredTools[]`, `contextRequirements[]` from it to build the prompt and capability policy. Without a table, that data has to live in code — which tightly couples the runtime to a fixed set of skills.

The question is how much of the marketplace schema to build now.

**My recommendation: build the full `skills` table schema now, but only seed system skills for MVP. User-authored skills are a Phase 3+ feature.**

The schema difference between "full" and "MVP" is only two columns — `forkOf` and `authorId` — and they're cheap to include. Excluding them now means a migration later when user skill authoring becomes a Phase 3 feature. Include them as nullable, seed only system-owned skills (authorId = null), and leave the API and UI for user-authored skills unbuilt for now.

The seeded skills for MVP would mirror aitradingbot:
- `base` — auto-injected at runtime (memory, messaging, costs) — not stored, injected in code
- `bot-management` — create/start/stop/monitor bots
- `risk-monitoring` — watch positions, alert on drawdowns
- `trade-review` — analyze closed trades, write lessons to memory

The `trading` preset the create form shows maps to `skillIds = ['bot-management']`. The agent runtime auto-injects `base` at tick time.

Do you agree, and are those four skills (base + three seeded) the right set for MVP?

## Answer 6

I agree

## Question 7

**Q7: Should an agent be required to specify `symbol` and `venue` explicitly when calling `create_bot`, or should the broker infer them from the agent's attached credentials?**

The current `TradingInstanceConfigSchema` requires `venue` (e.g. `"hyperliquid"`) and `symbol` (e.g. `"BTC-PERP"`) inside the config JSONB. The user's stated goal: "I don't want users to know the difference between BTC-USDC and BTC-PERP."

But this is about the *user* — the *agent* absolutely should know. The agent is the LLM that has already parsed the user's intent and resolved the venue from credentials. The agent calling `create_bot` is a technical actor writing a structured tool call, not a layman.

The real question is: who resolves `symbol` to its correct venue-specific format?

**Two paths:**

| Path | Who resolves | How |
|---|---|---|
| A — Agent resolves | Agent calls `search_instruments(query: "bitcoin")` → gets back `[{ symbol: "BTC-PERP", venue: "hyperliquid", ... }]`, then uses that in `create_bot` | Agent does the work; broker validates the result |
| B — Broker resolves | Agent says `create_bot({ asset: "BTC", intent: "long" })` — broker looks up the right symbol from the venue account's instrument list | Simpler for the agent, more logic in the broker |

**My recommendation: Path A — agent resolves, with a `search_instruments` tool.**

Consistent with agent-first: the agent is responsible for understanding the venue and instrument. The broker validates but doesn't guess. This also means `search_instruments` needs to be a seeded tool available to any agent with a trading skill, analogous to `search_tokens` in aitradingbot.

The corollary: `bots.config` keeps `venue` and `symbol` as required fields. The contract is that the agent has already resolved them correctly before calling `create_bot`.

Do you agree?

## Answer 7

I agree

## Question 8

**Q8: Should `strategyId` stay as a top-level column on `bots`, or move inside config JSONB?**

Currently: `bots.strategyId text NOT NULL` + `bots.config JSONB`. The worker uses `strategyId` to pick the right strategy class via `createStrategy()`. It also uses `config.strategy.type` from `TradingInstanceConfigSchema` — which is *also* the strategy type.

So `strategyId` on the table and `config.strategy.type` inside the JSONB are the same value stored twice. Look:

```ts
// API creates a bot:
strategyId: 'momentum'
config: { strategy: { type: 'momentum', ... }, ... }

// Worker loads it:
createStrategy(config.strategy)  // reads config.strategy.type, ignores strategyId
```

`strategyId` on the column is only used for display (dashboard, instance detail page title). The engine reads `config.strategy.type`.

**My recommendation: drop `strategyId` as a top-level column. Let `config.strategy.type` be the sole source of truth.**

The dashboard/UI query can extract it from JSONB: `config->>'strategy'->>'type'` or the API can project it on read. This removes a duplication that will bite us when someone updates `config.strategy.type` but forgets to update `strategyId` (or vice versa).

The trade-off: JSONB column filtering is slightly less ergonomic in SQL than a text column. For MVP scale (hundreds of bots, not millions) this is irrelevant.

Do you agree, or do you want to keep `strategyId` as a top-level column for query convenience?

## Answer 8

I agree

## Question 9

**Q9: When an agent calls `register_credential`, should that automatically create a `venue_account` row too, or are they still two separate operations?**

The current model keeps them separate: a `venue_account` can exist without a credential (for paper mode), and a credential can exist without a venue account. But for the agent path, the user's intent is: "here are my Hyperliquid keys" → agent does everything needed to start trading. The user doesn't think about credentials vs venue accounts as separate concepts.

**My recommendation: `register_credential` creates both in one brokered tool call — atomically.**

The tool receives the raw credentials from the agent (extracted from the user's prompt), encrypts and stores the `credentials` row, derives the `venue` from the credential type, creates the `venue_account` row linked to that credential, and returns both `credentialId` and `venueAccountId`. The agent then passes `venueAccountId` directly to `create_bot`.

For paper mode bots (no real keys), the agent calls `create_venue_account` directly with just `venue: "hyperliquid"` and no credential. Paper bots don't need real credentials.

The separation between credentials and venue accounts still exists at the DB level (correct) — it's just the agent tooling that collapses the two steps for the happy path.

**Implication for the `skills` table:** `register_credential` would be part of `bot-management` skill's `requiredTools` list. Or it could be a separate `venue-setup` sub-skill that gets auto-injected alongside `bot-management`. The simpler option for MVP: include it in `bot-management`.

Do you agree — one tool call creates both, paper bots can skip the credential step?

## Answer 9

I agree

## Question 10

**Q10: Should the constraint "at most one running bot per venue account" stay?**

The constraint `UNIQUE (venue_account_id) WHERE status != 'stopped'` currently prevents two bots running simultaneously on the same venue account. The rationale when it was written: two strategy bots fighting over the same account would create contradictory orders and undefined position state.

But in an agent-first model, consider: an agent creates a `bot-management`-skilled orchestrator that runs two bots against the same Hyperliquid account — one momentum, one range. This is a legitimate use case. The constraint would block it with a cryptic `23505` DB error.

The underlying concern (contradictory orders) is real but it's a *risk* concern, not an absolute invariant. The engine already has a risk gate. Position tracking is per-bot via `botId` (after rename). The engine reconciles per `venueAccountId`.

**My recommendation: remove the constraint, but keep the uniqueness check as a runtime guard in the broker.**

The broker's `manage_bot` handler checks the count of running bots per venue account before starting a new one. If the operator has `maxBotsPerVenueAccount: 1` in config (the default), the broker rejects the start. If the user/agent explicitly configures a higher limit, it's allowed. This makes the policy configurable rather than a hard DB invariant.

This is the same pattern as `maxBotsPerAgent` — operator config, not a DB constraint.

The current `23505` error handler in instances.ts that catches this constraint can be removed.

Do you agree to drop the DB constraint and replace with a configurable broker check?

## Answer 10

I agree

## Question 11

**Q11: Should `configVersion` stay on `bots` for MVP?**

The API increments it on `PATCH /bots/:id/config`. The UI displays it. Nothing uses it to guard against stale writes or replay decisions against the right config version. It's dead weight that adds a column to maintain and a field to explain in the API contract.

**My recommendation: drop it for MVP.** If we want optimistic concurrency later, we add it back — or use `updatedAt` as the ETag. The domain language doc references it but that was written before the agent-first model where config changes come from agents, not users manually patching. An agent that wants to check if a bot's config has changed can query the bot directly.

Do you agree to drop `configVersion` for MVP?

## Answer 11

I agree

## Question 12

**Q12: Should the `skills` table and `agent_credentials` table be created in Phase 1 (the current DB migration) or Phase 2?**

The Phase 1 migration is already touching many tables. Adding more risks scope creep. But consider the dependency:

- **Phase 2** ports the agent reasoning loop from aitradingbot. That loop reads `agent.skillIds`, resolves each skill ID against the `skills` table, and builds the prompt from `skill.instructions + skill.requiredTools`. Without the `skills` table, Phase 2 cannot start.
- **`agent_credentials`** — the `register_credential` brokered tool (Phase 2) needs somewhere to store the agent→credential link. Without `agent_credentials`, the tool can still write to `credentials` and `venue_accounts`, but there's no record of which agent owns which credential for cleanup on agent deletion.

**My recommendation: create both tables in Phase 1, but leave them empty until Phase 2 fills them.**

The schema change is trivial (two small tables). Creating them in Phase 1 means the Phase 2 agent runtime can assume they exist. Not creating them means Phase 2 needs its own DB migration, which is fine but adds a step.

`skills` table (mirrors aitradingbot exactly):
```ts
id, authorId (null = system), name, description, instructions, 
requiredTools text[], contextRequirements text[], 
requiredGuardrails text[], suggestedTickIntervalMs,
visibility, tags text[], forkOf (self-ref nullable),
createdAt, updatedAt
```

`agent_credentials` table:
```ts
id, agentId (FK → agents), credentialId (FK → credentials),
label (e.g. "hyperliquid_main", "twitter_api"),
createdAt
```

Also: `agents.skillIds text[]` replaces `agents.skillPreset text` — this is Phase 1 schema work regardless.

Do you agree to include both tables in the Phase 1 migration?

## Answer 12

I agree

## Question 13

**Q13: Should plan-level bot limits (`maxBots`) and agent-level bot limits (`maxBotsPerAgent`) be the same thing, or two separate controls?**

Currently `maxTradingInstances` is a total bot count per user across all their agents. The planned `maxBotsPerAgent` (in default.yaml under `agents:`) limits how many bots one agent can run concurrently.

Two different axes:
- **User-level**: how many bots total can this user have? (plan tier)
- **Agent-level**: how many bots can one agent spin up? (operator safety cap)

Both are necessary:
- Without user-level: a free user creates 5 agents, each creates 5 bots = 25 bots on a free plan
- Without agent-level: one runaway agent creates unbounded bots

**My recommendation: keep both, rename `maxTradingInstances` → `maxBots` in the plan config.**

default.yaml:
```yaml
free:
  maxBots: 5          # was: maxTradingInstances
  maxVenueAccounts: 5
  maxCredentials: 5
  maxAgents: 5
  # maxPortfolios removed

agents:
  maxBotsPerAgent: 5  # already planned
```

plan-guards.ts: rename `checkTradingInstanceLimit` → `checkBotLimit`, remove `checkPortfolioLimit`.

The broker checks both: agent-level (`maxBotsPerAgent`) before creating a bot, plan-level (`maxBots`) as the hard ceiling for the user's account.

Do you agree to keep both controls with this naming?

## Answer 13

I agree

## Question 14

**Q14: Should the `billing_customers`, `billing_subscriptions`, and `billing_webhook_events` tables stay for MVP?**

They're fully implemented with a `billing-repository.ts`, routes, and Creem/Stripe webhook handling. Billing always runs; in local dev/CI the `mock` provider auto-fulfills checkout without external calls. In production, set `BILLING_PRIMARY_PROVIDER=creem` (or `stripe`) alongside the provider credentials. The plan limits (`maxBots`, `maxAgents`, etc.) are enforced regardless of which provider is active.

Removing billing from the schema would require removing a significant amount of already-working code that doesn't affect correctness. It's off by default and doesn't block any agent feature.

**My recommendation: keep billing tables as-is.** They're not in our way, they're already working, and the MVP needs plan-gated limits even if nobody is paying yet. Removing them would be churn for no benefit.

`instruments` is different — it's schema with no implementation. 

**My recommendation: keep `instruments` too, but note it's unpopulated.** The `search_instruments` tool (Phase 2) will need to populate it. Dropping it now and re-adding it in Phase 2 is pointless churn. Leave it; seed it as part of Phase 2 venue setup.

Both stay untouched. That's a non-decision but it's worth stating explicitly so we don't waste time on them.

## Question 15

**Q15: Should `decisions`, `orders`, `fills`, `positions`, `execution_plans`, `journal_events` have a FK constraint on `botId`, or keep it as a loose text reference?**

Currently all these tables have `trading_instance_id text NOT NULL` with no FK. That means a bot can be deleted while its decisions/fills/positions still reference it — no DB-level cascade or protection.

**Two options:**

| Option | FK behaviour | Trade-off |
|---|---|---|
| A — FK with SET NULL | `botId` becomes nullable in decisions/fills/etc; set to NULL if bot deleted | Positions with no botId are ambiguous — whose P&L is it? |
| B — FK with RESTRICT | Cannot delete a bot that has decisions/fills/positions | Forces explicit cleanup before deletion, safe for audit |
| C — No FK (current) | Bot deletable at any time; orphaned records stay | Simple but leaves dangling references |

For a trading system, the audit trail (`decisions`, `fills`, `positions`) must survive bot deletion — you need to know what happened even after the bot is gone. Option A preserves the records but loses the bot reference. Option B prevents deletion until the audit trail is archived.

**My recommendation: FK with SET NULL on `decisions`, `fills`, `positions` (audit tables), and no FK on `orders`, `execution_plans`, `journal_events` (operational tables that become irrelevant after bot stops).**

This way: delete a bot → its decisions/fills/positions remain for audit with `botId = NULL`, but the `userId` on the bot can't be used for attribution after deletion. A better approach would be to keep `botId` and add `userId` directly to the audit tables.

Actually — that's scope creep for Phase 1. 

**Simpler recommendation: keep all as loose text (no FK) for Phase 1, same as current.** The rename from `tradingInstanceId` to `botId` is the only change. FK discipline is a Phase 4 (hardening) concern.

Do you agree to leave all child table references as loose text for now?

## Answer 15

I agree, but

Whatabout agentId? I hope we are not missing the fact that agents can trade directly; which means that decisions, orders, fills, positions, execution_plans, journal_events etc should probably have actorId/initiatorId and actorType/initiatorType rather than botId.

What do you think?

## Question 16

You're exactly right, and this is a significant observation. `decisions` already has `actorType`/`actorId` — but then also has `tradingInstanceId`. The other tables have only `tradingInstanceId` with no actor tracking at all.

The current model assumes: every decision/order/fill/position is scoped to a bot. But if an agent trades directly (no bot), there is no `botId` to put in that column.

**Here's the correct model:**

`tradingInstanceId` was serving two conceptually different purposes:

| Purpose | Right column |
|---|---|
| **Who initiated this?** | `actorType` + `actorId` (agent, bot, user, system) |
| **Execution context** — which venue account, which symbol, what position state | `venueAccountId` (already on positions/fills) |

`tradingInstanceId`/`botId` was conflating both. The execution context for direct-agent trades is the venue account, same as for bot trades. The actor is the agent.

**My recommendation: drop `tradingInstanceId`/`botId` from all child tables. Replace with `actorType` + `actorId` for actor tracking, and rely on `venueAccountId` (already present on fills/positions) for execution context.**

The query "show me all decisions by this agent" becomes `WHERE actorType = 'agent' AND actorId = agentId`. The query "show me all fills on this venue account" becomes `WHERE venueAccountId = id` (already works). The query "show me all decisions by this bot" becomes `WHERE actorType = 'bot' AND actorId = botId`.

Tables that don't currently have `venueAccountId` (`decisions`, `execution_plans`, `journal_events`) would need it added — but `decisions` already has `instrumentId`, and the venue can be derived from the bot/agent context. For `execution_plans` and `journal_events`, `venueAccountId` should be added.

This is a cleaner schema than renaming `tradingInstanceId` to `botId` — it removes a structural assumption that execution always involves a bot.

Do you agree, or do you want to keep `botId` as an optional nullable field alongside `actorType`/`actorId` to avoid adding `venueAccountId` to more tables?

## Answer 16

I agree with your recommendation, especially: "drop `tradingInstanceId`/`botId` from all child tables. Replace with `actorType` + `actorId` for actor tracking, and rely on `venueAccountId` (already present on fills/positions) for execution context."

## Question 17

**Q17: `execution_plans` already chains `decision → plan → orders → fills`. Does it need `venueAccountId` and `actorType`/`actorId` directly, or is the chain sufficient?**

`execution_plans` links to `decisionId`. `decisions` will have `venueAccountId` + `actorType` + `actorId` after the change. So the full chain is:

```
execution_plan.decisionId → decision.venueAccountId
                           → decision.actorType / actorId
```

The trade-off: querying "all execution plans for this agent on this venue account" requires a join through `decisions`. Adding the columns directly makes it a single-table query.

**My recommendation: add them directly to `execution_plans` too.** The join is avoidable and this table is operational (short-lived, queried by the running engine). Denormalize for query speed.

`journal_events` is different — it's a general-purpose append-only log. It already has `venue` and `symbol` embedded in the payload JSONB for most event types. `actorType` + `actorId` as top-level columns is worth adding for filtering, but `venueAccountId` is optional since the payload captures it.

**My recommendation: add `actorType` + `actorId` to `journal_events`, but not `venueAccountId` — the payload already carries it.**

Do you agree with both recommendations?

## Answer 17

I agree

## Question 18

**Q18: Does the `bots` table need a FK from `venueAccountId` → `venue_accounts`?**

We agreed in Q1 that a bot requires a `venueAccountId` at creation time. We noted the current schema has no FK. With the fresh migration, we should add it.

The question is the delete behaviour: if a venue account is deleted, what happens to its bots?

- `ON DELETE RESTRICT` — can't delete a venue account that has bots. Forces cleanup. **Safest for a trading system** — you wouldn't want the venue account to disappear from under a running bot.
- `ON DELETE SET NULL` — `venueAccountId` becomes null on the bot. A bot with no venue account is non-functional but the row persists.
- `ON DELETE CASCADE` — deletes the bot. Destroys history.

**My recommendation: `ON DELETE RESTRICT`.** A running bot's venue account cannot be deleted. Stopping the bot first is the correct sequence. This matches how credentials are protected — `credential-dependents.ts` already blocks credential deletion if venue accounts reference it.

Do you agree?

## Answer 18

I agree

## Question 19

**Q19: Should `config.venue` and `config.venueType` be removed from `bots.config` JSONB since the venue is already captured by the FK to `venue_accounts`?**

Current state:
```
bots.venueAccountId → venue_accounts.venue = "hyperliquid"
bots.config.venue = "hyperliquid"          ← duplicate
bots.config.venueType = "orderbook"        ← derivable from venue_accounts.venue
```

`venue_accounts` has a `venue` column. The engine currently reads `config.venue` to load the right venue adapter. If we drop `config.venue`, the engine would need to join to `venue_accounts` to get it.

However, `config.venueType` (`orderbook` | `swap`) is a bot-level concern — it determines which execution path the engine takes. It's not on `venue_accounts`. `venueType` could stay in config.

**Two sub-questions:**

1. Drop `config.venue` and let the engine derive it from `venue_accounts.venue` — yes or no?
2. Drop `config.venueType` or keep it in config?

**My recommendation:**

1. **Keep `config.venue`** — the engine reads it to select the venue adapter at startup without needing a join. The FK ensures they stay consistent (you can't assign a Hyperliquid venue account to a Bybit config). The duplication is acceptable here because the FK is the authoritative source and the config value is a denormalized read copy.

2. **Keep `config.venueType`** — it's not on `venue_accounts` and is a runtime execution concern. Removing it would require either inferring it from `venue` (hardcoded mapping) or putting it on `venue_accounts` (wrong layer — the same Hyperliquid account could theoretically be used in orderbook mode).

Both stay. No change. Not worth the churn.

That closes the schema questions. Do you agree, or do you want `venueType` moved to `venue_accounts`?

## Answer 19

I agree

## Question 20

**Final table delta — reconciliation_events: just drop `tradingInstanceId`, keep `venueAccountId`.**

Updated complete map:

| Table | Remove | Add |
|---|---|---|
| `decisions` | `tradingInstanceId` | `venueAccountId` |
| `orders` | `tradingInstanceId` | `actorType`, `actorId`, `venueAccountId` |
| `fills` | `tradingInstanceId` | `actorType`, `actorId`, `venueAccountId` |
| `positions` | `tradingInstanceId` | `actorType`, `actorId` |
| `execution_plans` | `tradingInstanceId` | `actorType`, `actorId`, `venueAccountId` |
| `journal_events` | `tradingInstanceId` | `actorType`, `actorId` |
| `decision_contexts` | `tradingInstanceId` | `actorType`, `actorId`, `venueAccountId` |
| `reconciliation_events` | `tradingInstanceId` | — (venueAccountId already present) |

---

**Q20: Should the `credentials` table be renamed to `user_credentials`?**

You said "credentials could be user_credentials" in Q4. This is a cosmetic rename but it has real scope — `credentials` is referenced in ~12 files (routes, plan-guards, credential-dependents, schema/index, web API client). It's a Phase 1 migration table change.

**My recommendation: yes, rename to `user_credentials`.** The name makes the ownership model explicit — these are user-owned secrets, distinct from `agent_credentials`. The rename cost is bounded (one migration + grep-replace) and prevents future confusion when `agent_credentials` exists alongside it.

Do you agree, or defer this rename to avoid scope creep in Phase 1?

## Answer 20

I agree

## Question 21

**Q21: When an agent trades directly AND also has a bot trading on the same venue account and symbol, are those two separate positions or one?**

Example: agent trades BTC-PERP directly (size +1), then its bot also goes long BTC-PERP (size +1). On Hyperliquid, the venue sees +2 total. But locally, we'd have two position rows — one with `actorType='agent'`, one with `actorType='bot'`.

The risk gate currently prevents this inconsistency by checking `getOpenByInstance` — only one actor (the instance) can have a position. With the new model, an agent and its bot could independently accumulate conflicting or additive positions on the same venue account and symbol without the risk gate knowing.

**My recommendation: scope the risk gate check to `venueAccountId` + `symbol` across ALL actors, not just the current actor.**

When any actor submits a decision for `(venueAccountId, symbol)`, the risk gate queries:
```sql
SELECT SUM(size) FROM positions
WHERE venueAccountId = ? AND symbol = ? AND closedAt IS NULL
```
This gives the total local exposure on that account+symbol regardless of who holds it. The actor's *own* position is a subset. The risk gate checks total exposure, not just the submitting actor's exposure.

This is the correct model for a multi-actor system: the venue doesn't know about herobids' internal actor split — it only sees the net position.

The `idx_positions_open` index currently covers `(tradingInstanceId, closedAt)`. After the change it should cover `(venueAccountId, symbol, closedAt)` for this query.

Do you agree — risk gate checks total exposure per `(venueAccountId, symbol)` across all actors?

## Answer 21

I agree

## Question 22

**Q22: Should `positions` have two indexes — one for per-actor queries and one for risk gate queries — or one composite?**

After the change, the two main query patterns on `positions` are:

1. **Per-actor** (what positions does this bot/agent hold?): `WHERE actorType = ? AND actorId = ? AND closedAt IS NULL`
2. **Risk gate** (what is the total exposure on this venue account + symbol?): `WHERE venueAccountId = ? AND symbol = ? AND closedAt IS NULL`

Currently there's one index `idx_positions_open` on `(tradingInstanceId, closedAt)` that served pattern 1 only.

**My recommendation: two separate indexes.**

```ts
index('idx_positions_actor').on(t.actorType, t.actorId),       // pattern 1
index('idx_positions_venue_symbol').on(t.venueAccountId, t.symbol),  // pattern 2
// closedAt filter is low-cardinality; Postgres will use a partial scan efficiently enough
```

The `idx_positions_open` composite on `(tradingInstanceId, closedAt)` is replaced. We don't need `closedAt` in the index key itself — a table scan filtered by `closedAt IS NULL` on a small positions table is fast enough for MVP scale.

Do you agree?

## Answer 22

I agree



