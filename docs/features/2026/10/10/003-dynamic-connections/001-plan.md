# Plan: Dynamic Connections (WP-A)

**Status:** draft
**Created:** 2026-10-10
**Epic:** [002-agent-onboarding-epic/000-roadmap.md](../002-agent-onboarding-epic/000-roadmap.md)
**Source:** [000-discovery.md](./000-discovery.md) (the problem, the observed session, the owner's answers)
**Related:** [WP-B trading provisioning](../005-post-creation-trading-provisioning/001-plan.md) (running-agent grant, generated test wallet), [WP-C simplified creation](../006-simplified-agent-creation/001-plan.md)

## Goal

An agent that needs a connection (Gmail, a trading venue with the user's own keys, others) can find out what exists, ask the user to create or approve one through a short-lived link, and is woken when the user finishes or declines. No code in this plan changes how connections are stored; it adds the discovery, the request, the completion hook and the instructions.

Scope boundary with WP-B: the generated test wallet for paper trading is created by the platform without a link (WP-B). This plan covers connections that need the user: their own wallet or API keys, OAuth (Gmail), or approval to reuse an existing connection.

## Verified facts (code, 2026-10-10)

1. **The existing link is a login link.** `createAndStoreSetupLinkToken` stores `auth:setup-link:token:<token>` → `{ userId }` in Redis with a TTL (`apps/api/src/services/setup-link-token-service.ts`). `GET /auth/setup-link/callback` consumes it, issues a session and redirects to `/setup/provider-link?code=…` with no provider parameter (`auth.ts` ~L510-542). After the user creates the connection they must run `/connect <agent> <id>` in Telegram, which requires a stopped agent.
2. **The worker already has a pattern for asking the platform to do things.** A tool publishes an inbound message carrying a `requestMessageId`, blocks on a Redis reply list, and the worker's broker handles it under capability policy (grant, rate limit, concurrency) with database access. `add_skills` is the template: `MANAGE_AGENT_SKILLS`, reply key `agent:skills:reply:{requestMessageId}`, handled in `apps/worker/src/agents/agent-message-broker.ts`. New tools must also be registered in `KNOWN_AGENT_TOOL_NAMES` / `TOOL_CATALOG` and in the default capability grants.
3. **The worker cannot import API code.** The token service is only Redis, but it lives in `apps/api`. Session issuing is API-only. The worker has no HTTP client to the API.
4. **The provider catalog is portable.** `apps/api/src/providers/registry.ts` imports only `@herobids/domain`, `node:crypto` and local types, so it can move into a shared package for the worker to read. It takes the operator `venues` config for wallet-generation availability; the worker would need that config.
5. **Connection rows are written in at least three places:** `setup.ts` (two inserts inside `createProviderLink`) and `connections-oauth.ts` (Gmail callback). Both entry points for a user-created connection are the setup form and the OAuth callback.
6. **The "no account" error is a single generic one.** `selectedAccountUnavailable()` returns `precondition.not_ready` / "selected trading account is unavailable" for both "no connection granted" and "granted but no resolved venue account" (`apps/worker/src/tools/risk-limits.ts`; similar `not_ready` returns in `account.ts` and `resolvers.ts`). The resolver `selectedVenueAccountResolver` in `agent.ts` returns only `null`.
7. **The setup form only partly supports a pre-selected provider.** `initialProviderId` preselects, but the Trading option group renders only when `defaultCapability === 'trading'` (`ProviderSetupForm.tsx`). A trading provider id with no capability would preselect an option that is not rendered.
8. **Waking an agent is a Redis XADD** to `agent:outbound:{agentId}` (`InstanceEventPublisher.emitAgentWake`, worker; the API does the same for `POST /agents/:id/message`). Wake payloads have a typed `source` (`AgentWakePayloadSchema`); a `connection` source does not exist yet.
9. **Granting a connection requires a stopped agent** and creates an empty profile when none exists. Both are addressed by WP-B (running-agent grant path with a profile provisioning step).
10. **Plan limits apply to creation** (`checkConnectionLimit`; free plan: 5 connections) and surface from the form as `plan.limit_exceeded`.

## Design

### A1. Say what is actually wrong (error split)

Replace the single not-ready result for a missing trading account with two codes, both non-fault, namespaced as dot-strings:
- `connection.missing`: no active granted connection for the needed family. Message names the capability and tells the agent to call `list_providers` and then `request_connection`.
- `connection.provisioning`: a connection is granted but has no resolved venue account yet. Message says it is being set up and to retry shortly; no request needed.

`selectedVenueAccountResolver` returns a reason alongside the id so the tools can choose. Tests assert the agent-visible text never suggests the account is merely "initializing" when nothing is connected.

### A2. `list_providers` (local worker tool)

- Reads the shared catalog and the agent's own grants from the database (the worker has both), so no broker round trip is needed.
- Params: optional `capability` (for example `trading`, `email`).
- Returns per provider: `provider` (the id `request_connection` accepts), `displayName`, `capabilities`, `authMethod` (oauth, api_key, generated_wallet), `hasActiveConnection` (the owner already has one) and `grantedToThisAgent`.
- Trading providers are listed only when the agent has a trading skill or `capability: 'trading'` is passed, consistent with trading staying out of generic surfaces.
- Always visible, added to the base skill's required tools and the tool catalog.

### A3. `request_connection` (brokered tool)

A new brokered capability `request_connection`, following the `add_skills` pattern (policy grant, rate limit such as a few per hour, one pending request per agent and provider).

Params: `provider` (validated against the catalog; unknown ids return the valid list), `mode`: `create` (default) or `use_existing`.

Handler (in the worker broker):
1. Reject providers not in the catalog or not allowed for this agent.
2. Create a request record in Redis (shared contract, a Zod schema in `packages/domain`): `{ requestId, token, agentId, userId, provider, mode, status: 'pending', createdAt, expiresAt }`, with a TTL from operator config (`connectionRequests.ttlSecs`, default from `loginLinkTtlSecs`). The `token` is a random bearer secret generated here, so the worker never touches session code.
3. Add `requestId` to a pending sorted set scored by `expiresAt` (for the expiry wake).
4. Reply to the tool with `{ requestId, link, expiresAt }` so the agent can forward the link to the user via `send_message` (the platform picks the channel).

**Decision (owner, 2026-10-10): the agent receives the link.** The tool returns the link in its reply so the agent can forward it to the user. The link carries a short-lived single-use bearer token; the instructions tell the agent to forward it promptly and not to persist it beyond the message. The agent also gets `requestId` and `expiresAt` so it can explain the request and its expiry.

`use_existing` exists because an agent must never grant itself a user's connection. When `list_providers` shows `hasActiveConnection`, the agent requests approval and the page lists the user's matching connections with a confirm button.

### A4. Redeem endpoint and the request form (API and web)

- `GET /auth/connection-request/callback?token=…` (API): looks the token up, checks it is pending and unexpired, issues a session like the setup-link callback, redirects to `/setup/provider-link?code=…&provider=…&requestId=…`. The token is deleted only after the session is issued, as in the existing callback.
- The setup page reads `provider` and `requestId`. For a request link the provider is locked (no dropdown), the trading group renders whenever the provider is a trading provider, and the form shows who is asking ("<Agent> is asking for…") with a Cancel button. Generated-wallet versus own keys is offered where the provider supports both.
- Cancel and the completion paths both end the request: `declined` or `completed`.
- OAuth providers (Gmail): `requestId` is carried through the OAuth `state` so the callback can complete the request. The form already stashes drafts around OAuth redirects (`onBeforeOAuthRedirect`), so this reuses that approach.

### A5. Completion hook and wake

Because only linked requests wake an agent, hook the two places a user creates a connection instead of refactoring every connection write into a repository. After a connection is created (setup form, OAuth callback) with a `requestId`, call one `completeConnectionRequest(requestId, connectionId)`:
1. Verify the request is pending, belongs to this user, and the provider matches.
2. Grant the connection to the requesting agent through the WP-B running-agent grant path (with profile provisioning for trading providers).
3. Mark the request `completed`, remove it from the pending set.
4. Wake the agent: `agent.wake` with `source: 'connection'`, `reason: 'completed'`, context `{ requestId, provider, connectionId }`.

`declined` (Cancel) does the same with `reason: 'declined'` and no grant.

Wake publishing from the API: define a small port in `packages/domain` and implement it in the API with the same Redis XADD the worker's `InstanceEventPublisher` uses (the publisher itself lives in `apps/worker`, which the API cannot import). Add `connection` to the wake `source` enum and its rendering in the agent prompt (runtime composition) and the tick gate (it must count as a wake signal so the context-hash gate does not skip it).

**Expiry:** a worker-side sweeper over the pending sorted set wakes the agent with `reason: 'expired'` and the detailed message, then the agent decides what to do. **Owner decision (2026-10-10):** the implementing agent decides where this sweeper lives — prefer hosting it in the existing `reminder-coordinator` (which already emits agent wakes and holds the single-worker lease) unless there is a concrete caveat that makes a separate loop cleaner; do not add a second loop without documenting why the reminder coordinator could not host it.

Trade-off against the discovery doc's `ConnectionsRepository` idea: a repository would also catch connections the user creates elsewhere while a request is open. That is not needed for the loop (a user who already has the connection is handled by `use_existing`), it touches many call sites, and it has no home for a wake publisher in `packages/db`. Revisit only if "agent notices a connection created elsewhere" becomes a requirement.

### A6. Instructions

Add to the base skill instructions a short block, parallel to the skills block: the two error codes and what each means; the sequence `list_providers`, then `request_connection`; that the link will expire and to forward it to the user promptly without persisting it; that you will be woken on completion, decline or expiry; what to do on each (continue, ask whether to try again, or offer an alternative); never ask the user to paste secrets in chat. Keep it provider-neutral and free of trading wording.

## Work items

| # | Item | Gate |
|---|---|---|
| A1 | Error split in resolver and tools | tests: missing vs provisioning text and codes; agent no longer reads "initializing" |
| A2 | Move the provider catalog to a shared package; `list_providers` tool and catalog registration | tool test incl. `hasActiveConnection`; tool catalog assertion; trading filter |
| A3 | Request record schema in `packages/domain`; `request_connection` capability, broker handler, grant and rate limits; link returned to the agent | broker tests: unknown provider, duplicate pending, link returned in the reply |
| A4 | Redeem endpoint; form changes (locked provider, trading group, asker banner, Cancel, `use_existing` mode); OAuth state carries `requestId`; i18n in all locales | API tests; web tests; i18n regression test |
| A5 | `completeConnectionRequest`; wake port and API implementation; `connection` wake source, prompt rendering and tick-gate handling; expiry sweeper | integration test: complete, decline and expire each wake the agent once; wake survives the context-hash gate |
| A6 | Base-skill instructions | agent eval on the epic UAT (G1) |
| A7 | Config: `connectionRequests.ttlSecs` and delivery limits in `config/default.yaml` and its schema; env twins only if an env override is added | config tests |

Depends on WP-B B2 (running-agent grant) for A5 step 2 and on WP-H if the profile derivation is changed.

## Risks and open questions

1. **Bearer token in the LLM context** (A3): owner decided the agent receives the link; the token is short-lived and single-use, and instructions tell the agent to forward it promptly and not persist it.
2. **Which channel carries the link** when the user has none bound: the in-app conversation always works (WP-C D3); the link card must render there.
3. **Agent stopped when the user completes.** The grant still succeeds through the stopped-agent path; the wake waits in the stream until the agent starts. Verify the wake is not trimmed or dropped across a restart.
4. **Multiple agents asking for the same provider.** One pending request per agent and provider; the form shows the asker so the user can tell them apart.
5. **Plan connection limit** during the form: the limit error is shown to the user on the page; the request stays pending until expiry or cancel.
6. **Link abuse:** a prompt-injected agent could spam links. Rate limits in the capability grant and the one-pending-per-provider rule bound it; delivery goes only to the owner.
7. **Mirror and parity:** the wake schema and catalog live in `packages/domain`; check whether any of these files are covered by the parity-drift manifest before editing.
