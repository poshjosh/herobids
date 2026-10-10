# Plan: Simplified Agent Creation (Form + Guided Chat)

**Status:** draft
**Created:** 2026-10-10
**Epic:** [000-agent-onboarding-epic/000-roadmap.md](../000-agent-onboarding-epic/000-roadmap.md) (this plan is Work Package C; read the roadmap for ordering)

## Goal

Creating an agent needs two things from the user: a **name** (optional, auto-generated if skipped) and a **way to talk to the agent** (a channel). Everything else (goal, skills, connections, trading setup, model, schedule) is decided after creation by the agent itself, or by the user through conversation or the edit form.

Applies to both create entry points: the **form** and the **guided chat**. The **edit form is unchanged** and remains the place to tune an existing agent.

## Why this is feasible only after other work

The simplification removes the user's ability to configure skills, trading and connections at creation. That is safe only when an agent can acquire those itself. Hard prerequisites (see roadmap):

1. Dynamic connections (WP-A): `connection.missing` error, `list_providers`, `request_connection`, expiry-and-wake link flow.
2. Post-creation trading provisioning (WP-B): a blank agent that adds the trading skill and a connection must end up with a working trading profile (capital, execution mode, risk defaults from operator config). Not specified anywhere today (see Risk R-3).
3. A working user-to-agent channel. Today there is only Telegram, bound by pasting a chat id (see below).

The core API and in-app chat work in this plan (phases S1 to S2) can be built in parallel with WP-A/WP-B, but the form/chat **cut-over** (S3, S4) must not ship before WP-A and WP-B are verified end to end.

## Current state (verified in code, 2026-10-10)

| Area | Fact | Where |
|---|---|---|
| Create form | One form with name, goal, style, skill preset, skills, connections, capital, execution mode, strategy preset, Telegram chat id, email-delivery override, advanced settings. Name is prefilled from the account, not required to be typed, but the API requires it. | `apps/web/src/features/agents/AgentsPage.tsx` (`CreateAgentFlow`), `AgentFormBody.tsx` |
| Guided chat | LLM loop with tools `list_compatible_connections`, `request_connection_form`, `create_connection`, `list_available_skills`, `create_agent` (preset enum, capital, execution mode, strategy, scanner gating, authorization mode, connection id, Telegram chat id). Heavy trading branching in the system prompt. | `apps/api/src/routes/chat.ts` (prompt L127-421, tools L522-620, handler L1201+) |
| API | `POST /agents` requires `name` in the schema (`agents.ts` L154); `prompt` optional. Trading-capable agents require `executionDefaults`. The web form supplies the missing values itself (generated name, capital `'1000'` at `AgentsPage.tsx` L300), so a user can submit it with nothing typed. No `isDefaultPrompt`, no server-side `agentDefaults`. | `apps/api/src/routes/agents.ts` L153-232 |
| Blank goal | Already handled at runtime: `isBlankAgentGoal` + `EMPTY_JOB_DEFAULT_TEXT` ("do not start autonomous work until given a job; respond to user messages"). | `packages/domain/src/agent-goal.ts`, `apps/worker/src/runtime-composition.ts` L2436 |
| Lifecycle | New agents are inserted with `status: 'stopped'` and the user must press Start. A message to a stopped agent returns 409. | `agents.ts` L829, `agent-interactivity.ts` (`POST /agents/:id/message`) |
| User to agent channel | Only Telegram (`POST /telegram/webhook`, routing: slash command, reply, `/to`, plain text to the single running agent). Binding is **manual**: user pastes `telegramChatId` into profile or the form. Chat id is per user with a per-agent override. | `agent-interactivity.ts` L1084, `auth.ts` ~L890, `agent-repository.ts` `getEffectiveTelegramChatId` |
| Web chat with an agent | **Does not exist.** `POST /agents/:id/message` exists but no web UI calls it. The detail page only shows the read-only outbound message feed (`agentsApi.messages`). | `AgentDetailPage.tsx` L270 |
| Email | Outbound only: `send_email` via a Gmail-type connection, plus platform notification email. No inbound email, no agent mailbox. | `apps/worker/src/tools/email.ts` |
| WhatsApp | Not implemented. Planned in [multi-provider chat messaging](../000-multi-provider-chat-messaging/000-README.md). | n/a |
| Skills self-management | `list_skills`, `add_skills`, `remove_skills`, `search_skills` exist. `update_my_prompt` does not. | `apps/worker/src/tools/skills.ts` |

## Target user experience

```
Create agent
  Name (optional)                    <- auto-generated if blank
  How do you want to talk to it?     <- channel
    ( ) In this app                  <- default, zero setup
    ( ) Telegram
    ( ) WhatsApp                     <- when messaging Phase 4 ships
    ( ) Email                        <- when the email channel ships (WP-E)
  [Create]
```

On Create: the agent is created **and started**, the user lands in a conversation with it, and the agent's first turn greets the user and asks what they want to do. If the user asks for trading, the agent adds skills, and when it needs a connection it sends a link (WP-A).

Returning users who already have a bound channel see only the name field (channel binding is per user, see D2).

## Decisions

| # | Decision | Recommendation | Reason |
|---|---|---|---|
| D1 | What "connection to WhatsApp/Telegram/email" means (**owner decision 2026-10-10**) | A channel is a place the agent sends messages **to the user** and receives the user's replies from. Telegram/WhatsApp: a **chat address binding** (`chat_addresses`, shared platform bot or number), **not** a `connections` row. Email: the same idea, messages go to the user's own email address; outbound already exists (platform notification email with per-agent override), the reply-to-agent path is new (WP-E). A Gmail-type `connection` (agent sends as the user) remains a separate, optional thing. | [020](../000-multi-provider-chat-messaging/020-taxonomy-and-registry-placement.md) fixes "all chat providers are brokered, no user connection row". Using one word for both would make the create form and `request_connection` collide. |
| D2 | Channel scope | Channels are bound **per user**; agents inherit (matches today's `getEffectiveTelegramChatId`). Creating a second agent never repeats channel setup. | Keeps create to name-only for returning users. |
| D3 | In-app chat as a channel (**accepted by owner 2026-10-10**). External channel is therefore **optional but strongly recommended**, especially Telegram or WhatsApp, because the agent can only reach the user when the app is open otherwise. | Add a minimal in-app conversation on the agent detail page (and as the post-create landing) using existing `POST /agents/:id/message` and `agent_outbound_messages`. Not the `chat_sessions` model of [003](../003-agent-chat-sessions/000-notes.md). | Without it a user with no Telegram/WhatsApp cannot talk to the agent they just made. Whole simplification fails. |
| D4 | Auto-start on create | Create then start in one action, honouring billing and plan limits. | Stopped agents reject messages (409) and Telegram plain text routes only to a running agent. |
| D5 | Name | The form keeps generating a default name client-side (as today). Guided chat already generates one server-side. Making `name` optional on `POST /agents` is **low priority** and only helps non-UI callers. Whichever side generates it, it must be unique per user. | Names are the Telegram `/to <agent>` addressing key; collisions break routing. No DB unique index exists today (verify and add if needed). |
| D6 | Goal at creation | Not asked. If the guided chat user volunteers one, it is sent to the agent as the **first message**, not stored as the prompt. Persisting a durable goal is the agent's job via `update_my_prompt`. | Keeps Agent Mode Purity (goal is the creator's), avoids two sources of goal. |
| D7 | API compatibility | `POST /agents` keeps accepting the full payload. Blueprint instantiate, go-live clone, tests and integrations still use it. Only the two UIs are simplified. | Removing API fields is out of scope and not needed. |
| D8 | Telegram binding | Replace "paste your chat id" with a one-time deep link `t.me/<bot>?start=<token>` that auto-captures the chat and consents. The page waits for completion (poll or wake). | Matches [060](../000-multi-provider-chat-messaging/060-config-secrets-onboarding.md) principle "auto-capture over paste". Needs the `/start` collision handled (see Risk R-2). |

## Work breakdown

### S0. Prerequisite checks (no feature code)

- **Name uniqueness (checked).** No unique index on per-user agent names (`agents` has only `idx_agents_user_id`). Telegram handles duplicates by replying "Multiple agents named X" (`telegram-command-handlers.ts`). So uniqueness is desirable, not required: generate `AG-` plus 4 hex and retry once on a collision with an existing name of the same user.
- **Idle cost of a blank agent (checked).** No change needed. `skipUnchangedTicks` defaults to true, so the context-hash gate skips scheduled ticks whose context is unchanged. Exceptions: the first tick (the greeting we want), any user message or wake, and a forced full evaluation every 10th tick. With the 24 h non-trading default interval that is at most about one extra LLM call per ten days while idle.
- **Billing gate (checked).** `POST /agents` has no billing gate; only the guided chat's `create_agent` does. The real gate is at session launch in the worker (`agent-session-manager.ts`): when the account cannot spend, the launch is blocked, the agent returns to `stopped`, and a guardrail event is emitted (`billing.insufficient_funds`, `billing.top_up_required`, `billing.limit_exceeded`, `billing.account_suspended`). New users are not blocked: an account with no billing period yet may spend, and the free plan allows an overdraft (`hardCapCents: -100`, so a negative balance down to -$1). Design rule: a blocked spend must produce a clear message telling the user to credit the account. Because the LLM cannot run when spend is blocked, that message has to come from the platform (the existing billing notification and activity-feed text), not from the agent. The simplified create must show the same message when auto-start is blocked, with a link to billing. Errors that do not block the LLM (for example a connection limit) are returned to the agent as tool results, and it relays them.

### S1. API and runtime

1. `POST /agents`: add `autoStart?: boolean` (default true for UI callers, false for programmatic callers to preserve current API behaviour). Response includes the final status. Optional server-side `name` is low priority (D5).
2. First-turn greeting: when a blank-goal agent starts, inject a short first-run guidance block into the default prompt: introduce yourself, ask what the user wants, explain you can add skills, request connections and set your own goal. Reuse `EMPTY_JOB_DEFAULT_TEXT`; do **not** add an `isDefaultPrompt` column (redundant with `isBlankAgentGoal`).
3. `update_my_prompt` worker tool (the only unbuilt part of [blank-slate agents](../002-blank-slate-agents/001-plan.md)): register in `KNOWN_AGENT_TOOL_NAMES` and `TOOL_CATALOG` (otherwise `assertToolCatalogMatchesRegistry` fails at worker startup), publish an inbound message handled by `agent-message-broker`, effective next tick, journal old/new value and source (`user` | `agent`).
4. Base-prompt guidance for the connection loop belongs to WP-A and is only referenced here.

### S2. In-app conversation

1. Web: message composer and thread on the agent detail page, using `agentsApi` wrappers for `POST /agents/:id/message` and `GET /agents/:id/messages`; show agent state (starting, running) and disable send while not running.
2. Post-create landing: navigate to the agent page with the composer focused and an empty-state hint. No banner copy that references features that do not exist.
3. i18n: all new strings in `en.ts`, `ar.ts`, `hi.ts`; run the i18n regression test.
4. Rate limit exists (10 messages/min/user). Review it is acceptable for a conversation.

### S3. Simplified create form (web)

1. New `CreateAgentPage` form: name (optional, placeholder shows the generated name) and channel selector. No skills, goal, style, capital, execution mode, strategy, connections, Telegram id or advanced settings.
2. Channel selector shows only channels that are `available` and configured (platform health) per [060 surfaces](../000-multi-provider-chat-messaging/060-config-secrets-onboarding.md). Phase-gated: in-app only (S3), + Telegram deep link (S5), + WhatsApp, + Email when shipped. "In app" is preselected and never blocks creation; the form shows a short recommendation to also connect Telegram or WhatsApp so the agent can reach the user outside the app.
3. Create button calls `POST /agents` with `{ name?, autoStart: true }` and routes to the conversation.
4. Remove from the create path: `buildCreateAgentPayload` trading fields, skill preset selector, `PromptInputBlock`, create-time connection slot, OAuth draft stash (`CREATE_AGENT_OAUTH_DRAFT_KEY`). Keep these components only where `EditAgentModal` still uses them. Check shared use before deleting (lesson: never remove on grep alone; run the full web test suite).
5. Edit form unchanged. Ensure it can still add skills/connections/capital that creation no longer asks for.

### S4. Simplified guided chat

1. Rewrite the guided-chat system prompt to one purpose: get a name (optional) and a channel, then create. Remove the trading branches (`preferredCapability: "trading"`, capital, execution mode, strategy, scanner gating, authorization mode). Note they are already unreachable by default: `chat.guidedSetup.tradingEnabled` is false, so trading presets are refused and trading skills are filtered out; this step deletes the dead code and the flag.
2. Tools: keep `create_agent` with `{ name?, firstMessage? }` only. Remove `list_compatible_connections`, `request_connection_form`, `create_connection`, `list_available_skills` from the guided chat (their replacements are the agent's own tools from WP-A).
3. Delete the trading-profile reconciliation saga call from the guided create path. This also removes one of the three duplicated profile-derivation paths in [harmonize agent create/update code paths](../000-harmonize-3-agent-create-or-update-code-paths/000-analysis.md).
4. Both UIs call one shared server-side `createAgent` core (name, channel, autoStart) so form and chat cannot drift.
5. With trading gone from guided chat, `GENERIC_FORM_SHOWS_TRADING_PROVIDERS` and the `defaultCapability="trading"` call sites in create flows become unreachable from creation; they stay for the agent-triggered connection link (WP-A).

### S5. Channel upgrades (can ship independently, in this order)

1. **Telegram deep-link binding.** Token minted by API (reuse setup-link token service pattern), bot handles `/start <token>` before slash-command parsing, writes the binding, UI polls binding status. Must intercept `/start <token>` ahead of `handleStart` (which treats the argument as an agent name).
2. **WhatsApp.** Delivered by [messaging plan](../000-multi-provider-chat-messaging/900-implementation-plan.md) Phase 4 (needs Phases 1 to 3). The create form only adds an option.
3. **Email.** Messages go to the user's own email address (outbound already exists). Replies reaching the agent need its own design (WP-E): inbound email ingestion, reply threading, sender verification. A Gmail-type `connection` (agent sends as the user) stays a separate optional grant.

## Removal list (confirm with full test suites before deleting)

- `apps/web`: create-time skill preset UI, `PromptInputBlock` on the create path, create-time capital/execution/strategy controls, OAuth draft for create.
- `apps/api/src/routes/chat.ts`: trading prompt sections, four tools listed in S4, trading params of `create_agent`, preset helpers (`resolveSkillPresetSkillIds` etc.) if no other caller remains, `synthesizePrompt`, `generateAgentName(preset)` (replace with the server generator).
- Docs and landing copy that describe the old create flow (proof cards, help pages in `apps/web/src/features/public-pages/content/**` and regenerate `platform-docs-data.ts` via `pnpm --filter @herobids/scripts run build-docs-index`).

## Testing

- API: `POST /agents` with no body creates a named, started agent; generated names are unique per user and never reserved; full legacy payload still works; billing and plan limits still gate.
- Worker: blank-goal agent greets on first turn; does not start autonomous work; `update_my_prompt` persists and journals; tool catalog assertion passes.
- Web: create form submits name-only and channel; returning user with a bound channel sees name only; composer sends and renders; edit form still edits everything.
- Guided chat: conversation ends in `create_agent` with name and channel only; no trading tool or prompt text remains (assert on tool list and prompt).
- Telegram deep link: `/start <token>` binds and does not hit `handleStart`; expired and reused tokens rejected.
- End-to-end (UAT): create, say "help me trade crypto", agent adds skills, gets `connection.missing`, lists providers, sends link, user completes it, agent wakes and proceeds to a trade in test mode. This is the acceptance test for the whole epic.
- `pnpm lint`, `pnpm test`, `scripts/shell/tests/run-all-tests.sh --e2e`.

## Non-goals

- Changing the edit form or `PATCH /agents`.
- Removing API fields or backward compatibility for programmatic callers.
- Agent-initiated messaging outside a session window (see messaging non-goals).
- SMS as a creation channel (it is in the messaging plan but not in the product list for this flow).
- Replacing the chat-sessions idea wholesale; this plan only needs a minimal in-app conversation (D3).

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Idle blank agents cost tokens or run slots. | S0 check; skip blank-goal ticks; plan agent limits already apply. |
| R-2 | **Planned, not existing.** Today bare `/start` replies with help and the chat id (the manual-paste flow), and `/start <agent>` starts an agent (`agent-interactivity.ts` ~L656-700, `handleStart`). A deep link `t.me/<bot>?start=<token>` would arrive as `/start <token>` and be read as an agent name. | Look the token up first (short-lived, single-use Redis key); if found, bind the chat; if not, fall through to `handleStart` unchanged. No reserved agent names needed. Fallback if rejected: the web page shows a code and the user sends `/link <code>` (no collision, two more steps). |
| R-3 | A blank agent adds the trading skill + connection but has no usable trading profile. Verified: grant creates an all-null profile that traderton cannot run, no server-side default capital exists, and grant requires a stopped agent. | Solved by [WP-B](../000-post-creation-trading-provisioning/001-plan.md): ask once, defaults or specifics through one tool, test mode only, running-agent grant path. |
| R-4 | Users lose the visible "I am creating a trading agent" affordance. | Landing and help copy shift to "talk to your agent"; trading discoverability moves into the agent's replies and the skills catalog page. |
| R-5 | Two creation UIs that are now nearly identical. | Keep both as required, but share one core (S4.4). Revisit whether guided chat earns its keep after launch metrics. |

## Open questions

1. ~~Email semantics~~ Decided: email works like Telegram/WhatsApp (messages go to the user's address). Remaining: replies by email reaching the agent need an inbound path (WP-E); until then email is outbound-only and the agent says where to reply.
2. ~~In-app chat~~ Decided: accepted; external channel optional, strongly recommended.
3. Should the first message in guided chat be forwarded as the agent's first user message (D6) or discarded?
4. Auto-start default for the API (`autoStart` true only for UI callers) acceptable?
