# Prompt 1

Creating connections should be automatically triggered by agents the same way, adding skills is now done. When an agent has a task and needs a connection to say Gmail, Telegram, Hyperliquid etc the agent should add a link to a version of the "Add connection" form. We host that version on its own page, so it can be reach by links. I think we already have something like this through telegram slash commands. In this case, the default prompt for all agents should tell them how to initiate the creating of connections by sending a link to the user. The link will expire of course and also have a kind of hook to wake the agent when the connection is either successfully created or not (completed without success)

Here is a sample flow:

- agent wants to do something but there is no connection -> the error message is clear about there being no connection

- agent based on its prompt sends a link to the user to fill out the necessary connection form as explained earlier

- the form whould have something like ?provider=<provider> which triggers the selection of the specific provider

- agent needs a way to know about available providers and which to choose

By doing all the above, we could make permanent the removal of references to trading in our guided chat create agent form. Thereafter we could permit trading to only show in the connection form if `?provider=<provider>` is specified with a supported provider. This will not happen by default in the website but only when an agent triggers the process.

We decided to see how far our agents could go towards the above, before we even implement it. Below is what happened:

- app is currently deployed to local dev docker compose

- I created an agent with no skills or connections

- I asked the agent to help me trade crypto

- I noticed the agent added skills

- then tool call `get_risk_limits` failed with the below log in the activity feed.

```
Event Type  
tool.result  
Category  
tool  
Correlation ID  
55e6708d-b2d  
Direction  
inbound  
Status  
processed  
messageType  
agent.tool.result  
actorType  
agent  
payload  
phase  
judge  
status  
error  
tickId  
ffcccf9b-fdad-4a83-b321-5e5012eb706a  
summary  
selected trading account is unavailable  
toolName  
get_risk_limits  
correlationId  
35c72348-6ad7-4bb7-bd37-9d323a931c8d  
```

The agent then sent me the following message

```
💬 [crypto-trader]  
Crypto Trading Assistant Ready - Market Monitoring Active  
🚀 **Crypto Trading Assistant Initialized**  
I've set up your crypto trading assistant with the following:  
✅ **Skills Added:** Crypto trading, risk monitoring, and bot management capabilities loaded  
✅ **Market Monitoring:** Scheduled to check the market every 15 minutes (next check at 19:15 UTC)  
📊 **Current Market Snapshot (as of 19:03 UTC):**  
- BTC: $81,547.90 (-2.22%)  
- ETH: $2,450.44 (-4.37%)  
- HYPE: $83.82 (-4.61%)  
- ZEC: $1,145.40 (-13.62%)  
- NEAR: $4.55 (-13.76%)  
⚠️ **Note:** Your trading account appears to be initializing. Once ready, I can help with:  
- Real-time market monitoring every 15 minutes  
- Trade execution and position management  
- Risk management and stop-losses  
- Creating automated trading bots  
- Funding rate arbitrage opportunities  
Would you like me to:  
1. Set up specific watchlists for tokens you're interested in?  
2. Configure any particular trading strategies?  
3. Monitor specific price levels or conditions?  
Just let me know your preferences and I'll tailor the setup accordingly! 📈  
```

It seems like the error the agent recieved makes the agent think my trading account is initializing. Rather the error should be clear that the user needs to setup a connection/venue - something like that. This error would be a first step towards the "dynamic adding of connections by agents"

What do you think?

# Response 1

## What's actually going on

The symptom (agent thinks the account is "initializing") traces to a real root cause: `get_risk_limits` returns `{ error: 'selected trading account is unavailable', errorCode: 'precondition.not_ready', fault: false }` whenever `resolveSelectedVenueAccountId()` finds no active `agent_connections` row with a resolved venue account (`apps/worker/src/tools/risk-limits.ts:31-38`, resolver at `apps/worker/src/agent.ts:1850-1865`). Nothing distinguishes "no connection exists yet" from "connection exists but venue account isn't provisioned yet" — both collapse into one generic `precondition.not_ready`. The agent, with no documented failure-mode guidance for this error (unlike skills, which get an explicit instructional block in `BASE_SKILL.instructions`), filled the ambiguity with the most plausible guess: "initializing."

But fixing the message alone doesn't fix the capability gap. Even if the agent correctly concluded "I have no connection," it has **no tool to act on that conclusion**. `request_connection_form` / `list_compatible_connections` / `create_connection` only exist as tools inside the guided-chat onboarding LLM loop (`apps/api/src/routes/chat.ts`), invoked before an agent even exists. The worker runtime (`apps/worker/src/tools/*`) has no analogous tool — so a live agent mid-conversation literally cannot do what you're asking it to do yet.

## The pieces you already have that make this easy

1. **The skill-adding pattern is the template.** `add_skills`/`search_skills` (`apps/worker/src/tools/skills.ts`) show exactly the shape: a tool the agent calls, documented in `BASE_SKILL.instructions` with explicit "if blocked, do X" guidance, always visible regardless of permission level (`runtime-tool-visibility.ts:17-21`), with a hot-reload callback (`ctx.onSkillsChanged()`) so new capabilities become usable without a restart.

2. **The setup-link-token mechanism already does "expiring link."** `apps/api/src/services/setup-link-token-service.ts` — one-time Redis token, TTL from `authConfig.loginLinkTtlSecs`, per-user cooldown, consume-without-delete for link-preview safety, explicit delete on redemption. The Telegram `/connect` flow already builds `<publicBaseUrl>/auth/setup-link/callback?token=<token>` this way. This is directly reusable for an agent-triggered link.

3. **The wake mechanism already does "notify agent when async thing resolves."** `InstanceEventPublisher.emitAgentWake(agentId, payload)` with `source`/`reason`/`eventIds`/`context` is used today for reminders and market events (`apps/worker/src/reminder-coordinator.ts:157-166`). Adding `source: 'connection'` and firing it when a `connections` row transitions to active (or setup is abandoned/fails) is a natural extension, not a new subsystem.

4. **The link target already exists.** `ProviderSetupForm.tsx` + `/setup/provider-link` route, driven by `preferredCapability`/`preferredProvider`, already supports exactly the `?provider=<provider>` style trigger you're describing — it's gated today mostly by which caller passes `defaultCapability="trading"`.

5. **`GENERIC_FORM_SHOWS_TRADING_PROVIDERS = false`** is already the kill switch for hiding trading from the generic/guided form by default — your "only show trading if an agent explicitly triggers it via `?provider=`" idea is largely just: keep this false for organic traffic, and have the agent-triggered link set the query param explicitly, bypassing the catalog filter for that one link.

## Design sketch (not yet implemented, per your request)

**A. Fix the error message/shape first (small, independent, worth doing regardless of the rest):**
Distinguish in `risk-limits.ts` (and anywhere else sharing `resolveSelectedVenueAccountId`/`selectedAccountUnavailable`) between "no active `agent_connections` row at all" vs "row exists but `resolvedVenueAccountId` is null" (provisioning in progress). Two different error codes, e.g. `connection.missing` vs `connection.provisioning`, each with a clear `error` string that doesn't invite the "initializing" misread.

**B. Add a worker-side tool, e.g. `request_connection` (verb_noun, per your conventions):**
- Lives in `apps/worker/src/tools/connections.ts` (new), added to `BASE_SKILL.requiredTools` so every agent has it unconditionally — same as skills tools.
- Params: `provider` (string) + maybe `capability` hint.
- Implementation: mint a setup-link token (reuse `setup-link-token-service.ts`, scoped to the agent's owning user), build a URL like `.../setup/provider-link?token=...&provider=<provider>&agentId=<agentId>`, return it as `ToolResult.data` so the agent can `send_message` it to the user. Store enough state (e.g. in Redis alongside the token, or a small `connection_requests` row) to know which agent/tick to wake later.
- On the callback side (wherever `connections` rows get created/activated, and wherever setup is abandoned/expires), fire `emitAgentWake(agentId, { source: 'connection', reason: 'created'|'failed', context: { provider, connectionId? } })`.

**C. Document the tool and the failure mode in `BASE_SKILL.instructions`:**
A block parallel to the skills one: "If a tool fails with `connection.missing`, you likely need a connection for that provider. Use `request_connection` to get a link, send it to the user via `send_message`, and wait — you'll be woken when it resolves."

**D. Guided-chat form change:**
Keep `GENERIC_FORM_SHOWS_TRADING_PROVIDERS = false` as the default for all organic/guided-chat traffic. The agent-triggered link explicitly sets `?provider=<provider>` and that becomes the signal `ProviderSetupForm` uses to show that one trading provider regardless of the catalog flag — i.e. explicit provider param overrides the "hide trading" default, scoped to exactly that provider.

Open questions I'd want your call on before building:

- Should `request_connection` be scoped to providers that exist in the server-side catalog only, or can an agent request any arbitrary string (risk of a bad link to a nonexistent provider)? -> Answer:: scoped

- Expiry UX: what should the agent do/say if the link expires unused — auto-regenerate on next relevant tick, or wait for the user to ask again? -> Answer:: Send the detailed error message to the agent, let the agent decide what to do.


- Where should the "wake on connection resolved/failed" event actually be published from — is there a single choke point today where `connections.status` transitions, or is it scattered across OAuth callback, manual key entry, and `create_connection` (wallet generation)? Worth confirming before wiring the publisher. -> Answer: See section `Connection Error Event Handling`

**Connection Error Event Handling**

Don't publish the wake event from any of the existing scattered call sites directly. There's no natural single choke point today, and bolting `emitAgentWake` onto four-plus different route handlers means four-plus places that can drift, get missed on the next write path someone adds, or double-fire across a retry.

Instead, create one: **introduce a thin `ConnectionsRepository` in `packages/db/src/repositories.ts`** (next to the existing `ConnectionOwnershipRepository`, same file, same pattern) with the methods that actually mutate the table — `createConnection()`, `activateConnection()`/`markConnectionStatus()`, `revokeConnection()`. Migrate the ~6 call sites to use it instead of raw `tx.insert`/`tx.update`. That repository becomes the one choke point, and it's exactly the kind of change that pays for itself immediately: it's also where the plan-limit advisory lock and the `agent_connections` cascade-revoke logic currently get hand-rolled per call site (visible in `connections.ts:489-510` and `agents.ts:2136-2139`), so consolidating removes duplication the codebase already has, not just duplication this feature would add.

Concretely:

1. **New repository methods** in `packages/db/src/repositories.ts`, each taking an optional `eventPublisher` (or accepting it via constructor injection, consistent with "constructor injection for all dependencies" in AGENTS.md) and firing the wake *after* the status transition commits — ideally inside the same code path as `markLocalCommitted()` callbacks already used in `connections.ts`'s revoke transaction, so the wake only fires on confirmed commit, never on a rolled-back transaction.

2. **Only fire the wake when the connection is linked to an agent request.** Not every `connections` row transition should wake an agent — a user manually adding a connection from the Connections page unrelated to any pending agent ask shouldn't spam a wake. The `request_connection` tool (from the earlier design) should stash a correlation key (e.g. `connection_requests` Redis entry or a `meta.requestedByAgentId` field) at link-mint time; the repository's activate/fail method only calls `emitAgentWake` when that correlation key is present and resolves to a specific `agentId`. This also solves "failed" — if the token expires unredeemed, that's not a `connections` row transition at all (nothing was ever created), so the expiry wake has to come from the token layer (TTL expiry / cooldown check), not the repository. I'd implement expiry as: the `request_connection` tool reads back its own stashed state on the agent's next tick, or better, use the existing reminder/wake-scheduler to schedule a one-shot wake at `expiresAt + buffer` when the link is minted, and have that wake handler check "did a connection get created for this request" — if not, report the expiry as the detailed error back to the agent (per your answer: let the agent decide what to do next), if yes, do nothing (the success wake already fired).

3. **OAuth callback and manual-form and wallet-generation (`create_connection`) all funnel through the same repository method** for the actual row write, so the wake fires identically regardless of which UI path produced the connection. This is the main win: you get one enforcement point instead of three to keep in sync.

So to directly answer the question: today it's scattered (`connections.ts`, `setup.ts` x2, `connections-oauth.ts`, each with its own raw insert/update), there's no existing choke point. I'd create one — a small repository — rather than publish from each scattered site, specifically because the correlation-to-agent-request logic (point 2) needs to live somewhere shared anyway, and that's the natural place for it.

**Provider Discovery**

The prompt requires that the agent "needs a way to know about available providers and which to choose", but the design above only gave `request_connection` a free-form `provider` string. Without discovery the agent has to guess valid IDs, which defeats the "scoped to the catalog" answer.

1. **Add a worker-side `list_providers` tool** (in `apps/worker/src/tools/connections.ts`, next to `request_connection`), added to `BASE_SKILL.requiredTools` and always visible, like `add_skills`/`search_skills`.
   - Params: optional `capability` filter (e.g. `trading`).
   - Returns, per provider: `provider` (the ID accepted by `request_connection`), `displayName`, `capabilities`, `authMethod` (OAuth / API key / generated wallet), and `hasActiveConnection` (true when the agent's owner already has an active compatible connection that can be reused).
   - Source of truth is the existing provider catalog (`getProviderCatalog` in `apps/api/src/providers/registry.ts`, `ProviderCatalogResponse` in `packages/domain/src/provider-catalog.ts`). It is a read-only projection; the worker must not keep its own list. Open item: whether the worker calls the API catalog or consumes a shared domain projection.
   - Trading providers are returned only when the agent has the trading skill (or the `capability` filter asks for it), so organic/guided-chat traffic still never sees them (consistent with `GENERIC_FORM_SHOWS_TRADING_PROVIDERS = false`).

2. **`request_connection` validates against the same catalog.** An unknown `provider` returns a non-fault error listing the valid IDs, so a wrong guess is self-correcting.

3. **Document it in `BASE_SKILL.instructions`**, in the same block as the failure-mode guidance: on `connection.missing`, call `list_providers` (with a capability hint if known), pick the matching provider, check `hasActiveConnection`, then call `request_connection` and send the link to the user.

4. **Make the error point at discovery.** The `connection.missing` error from step A should name the missing capability and mention `list_providers`, so the agent does not need to infer the next step from instructions alone.

Updated sample flow: `get_risk_limits` fails with `connection.missing` (capability `trading`) -> `list_providers({ capability: 'trading' })` -> `request_connection({ provider })` -> `send_message` with the link -> agent is woken on success, failure, or expiry.

**Review corrections (2026-10-10)** — found when checking this design against the code; see the [epic roadmap](../000-agent-onboarding-epic/000-roadmap.md) F3-F6.

1. **Token minting crosses a process boundary.** `setup-link-token-service.ts` is in `apps/api`; `request_connection` runs in `apps/worker`. The worker cannot import it. Define how the tool gets a link (inbound message handled by the broker, or an API call) before implementing.
2. **Tool registration.** New tools must also be added to `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` in `packages/domain/src/tools.ts`; otherwise `assertToolCatalogMatchesRegistry` fails at worker startup. `BASE_SKILL.requiredTools` alone is not enough.
3. **The wake publisher is in the worker.** `InstanceEventPublisher` (`apps/worker/src/agents/instance-event-publisher.ts`) is a thin Redis XADD wrapper to `agent:outbound:{agentId}`, but connection writes happen in `apps/api` and `packages/db` cannot depend on apps. Use a domain port (e.g. `AgentWakePublisher`) injected into the repository, with an API-side Redis implementation, or move the publisher into a shared package.
4. **`?provider=` is not fully supported today.** `ProviderSetupForm` accepts `initialProviderId`, but the Trading option group renders only when `defaultCapability === 'trading'` (or when `GENERIC_FORM_SHOWS_TRADING_PROVIDERS` is true and no capability is given). `?provider=hyperliquid` with no capability would preselect an option that is not rendered. The agent link must also render the requested trading provider.
5. **Trading provisioning after the connection exists** is specified in [WP-B](../000-post-creation-trading-provisioning/001-plan.md): the grant currently creates an all-null profile traderton cannot run, and granting requires a stopped agent, so the link-completion path needs a running-agent grant.