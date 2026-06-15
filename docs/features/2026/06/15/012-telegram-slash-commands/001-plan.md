# Telegram Slash Commands

## Status

`draft`

## Purpose

Allow users to send messages to specific running agents via Telegram using `/to` slash commands. Supports targeting by agent name, multiple agents in one command, quoted names with spaces, and broadcast to all running agents. Includes default routing when only one agent is running.

## Scope

### In scope

1. Fully implement the Telegram webhook handler (currently a stub that drops all incoming messages).
2. Fix the webhook secret validation (security fix — currently compares against the bot token, which is wrong).
3. Register the webhook with Telegram at worker/API startup via `setWebhook`.
4. Implement `/to` command parser: single target, multiple targets, quoted names, `all` and `*` broadcast.
5. Implement default routing: if the user has exactly one running agent, forward any plain (non-command) message to it without requiring `/to`.
6. Case-insensitive agent name matching.
7. Name collision: send to all agents matching the name (user's problem for naming two agents the same).
8. Reply to the user with delivery confirmation or a clear error per target.
9. User verification: confirm the incoming `chat.id` matches `users.telegram_chat_id` before routing.
10. Tests (unit + integration).
11. User-facing documentation at `docs/public/documentation/telegram/slash-commands.md`.

### Out of scope

1. Reply threading routing (covered by `telegram-reply-threading` plan).
2. `/agents` list command — deferred.
3. Other slash commands beyond `/to`.
4. Per-agent Telegram bot tokens.
5. Multi-user bot shared with multiple accounts.

## Problem Statement

The Telegram webhook handler at `POST /api/telegram/webhook` currently acknowledges every incoming update and discards it silently. Users have no way to send instructions to a running agent from Telegram.

Additionally:
- The webhook secret validation incorrectly compares against the bot token rather than a separate webhook secret.
- The webhook is never registered with Telegram (`setWebhook` is never called).

## Target End State

1. A user can type `/to MyAgent check BTC price` in the Telegram bot chat and the message is delivered to the running agent named "MyAgent".
2. Multiple targets: `/to Agent1 Agent2 check BTC` delivers to both agents.
3. Quoted names: `/to "DCA Bot" start` handles spaces correctly.
4. Broadcast: `/to all stop` and `/to * stop` deliver to every running agent owned by the user.
5. Reserved words `all` and `*` cannot be used as agent names (validated at agent creation time).
6. Plain messages (no `/to` prefix) route to the user's single running agent, or prompt the user to use `/to` if multiple are running.
7. Agent stopped → reply "Agent <name> is stopped and cannot receive messages right now."
8. Agent not found → reply "No agent named <name> found."

## Command Syntax

```
/to <target> [<target> ...] <message>

Targets:
  AgentName           — exact name, case-insensitive, no spaces
  "Agent Name"        — quoted name (double quotes), allows spaces
  'Agent Name'        — quoted name (single quotes), allows spaces
  all                 — all running agents (reserved)
  *                   — all running agents (reserved)

Examples:
  /to Momentum buy BTC now
  /to "DCA Bot" pause trading
  /to Agent1 Agent2 what is your P&L
  /to "Bot One" Agent2 stop
  /to all daily summary please
  /to * stop
```

**Reserved words:** `all` and `*` must be rejected as agent names at creation/edit time (API validation, not just here). Existing agents named "all" or "*" should be migrated or warned.

**Name collision:** If two agents share the same name, the message is sent to both. The confirmation reply lists which agents received the message. Users naming two agents identically accept this behaviour.

**Default routing:** If the user has exactly one running agent and the message does not start with `/to`, deliver to that agent automatically. If there are zero or multiple running agents and no `/to` prefix, reply with instructions.

## Security Notes

- Same as the reply threading plan: the webhook secret fix is mandatory in the same slice.
- `chat.id` → `userId` resolution must always precede any agent lookup to prevent cross-user access.
- Agent lookup must always be scoped to `agents.user_id = userId`.
- The bot token must never appear in request/response headers or logs.

## Data Flow

```
User sends "/to AgentName do something"
  → Telegram sends POST /api/telegram/webhook
  → Validate X-Telegram-Bot-Api-Secret-Token against TELEGRAM_WEBHOOK_SECRET
  → Parse update: message.text, message.chat.id
  → Verify message.chat.id matches users.telegram_chat_id → get userId
  → Parse command: extract targets and message body
  → For each resolved target name:
      → Query agents WHERE lower(name) = lower(target) AND user_id = userId
      → If not found → collect "No agent named <name> found."
      → If found but stopped/crashed → collect "Agent <name> is stopped."
      → If found and running/starting/paused → xadd agent:outbound:{agentId}, collect "Delivered to <name>."
  → Reply with combined result summary
```

## Parser Specification

The command parser must handle:

1. Strip leading `/to` (case-insensitive — `/TO`, `/To` all work).
2. Consume tokens as targets until a non-target token is seen or quotes close.
3. A token is a target if it does not yet look like the start of a sentence (heuristic: targets come before a whitespace-separated word that is not a name-like token — see note below).
4. Simpler and more reliable approach: **targets end when a quoted string closes or when a bare word is followed by content that cannot be an agent name**. Implementation note: parse greedily — collect all leading tokens (quoted or unquoted) as targets; the remainder after the last target token is the message body.
5. Empty message body after targets → reply with a usage hint.
6. Empty target list → apply default routing rules.

Parser edge cases:
- `/to "DCA Bot" "Momentum" buy BTC` — two quoted targets, message is "buy BTC"
- `/to all` (no message body) → reply "Please include a message after the target."
- `/to` (nothing) → apply default routing with the full original message (minus `/to`)

## Files Expected To Change

### API

- `apps/api/src/routes/agent-interactivity.ts` — implement `telegramWebhookHandler`, add `setWebhook` call
- `apps/api/src/config.ts` — add `TELEGRAM_WEBHOOK_SECRET` to operator config schema
- `apps/api/src/routes/agents.ts` — add `all` and `*` to reserved agent name validation

### Worker / Alerting

- `apps/worker/src/alerting/telegram-client.ts` — add `setWebhook` method

### DB

- `packages/db/src/agent-repository.ts` — add `getRunningAgentsByUserId(userId: string)` and `getAgentsByNameAndUserId(name: string, userId: string)` queries

### Config

- `config/default.yaml` — document `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_WEBHOOK_URL`

### Tests

- `apps/api/src/routes/agent-interactivity.test.ts` — command parsing, routing, not-found/not-running replies, broadcast, default routing, secret validation
- `apps/api/src/routes/agents.test.ts` — reserved name rejection

### Documentation

- `docs/public/documentation/telegram/slash-commands.md`

## Implementation Plan

---

### Slice 1 — Security fix + webhook secret config

#### Goal

Replace the broken secret validation and introduce a proper `TELEGRAM_WEBHOOK_SECRET` config value. **Identical to Slice 1 in the reply threading plan — if both features are implemented, this slice is shared.**

#### Tasks

1. Add `telegramWebhookSecret` to operator config schema.
2. Update `telegramWebhookHandler` to validate against `telegramWebhookSecret` (not the bot token).
3. Document in `config/default.yaml`.

#### Exit criteria

- Handler returns 401 when the header is absent or wrong.
- Handler returns 501 when Telegram is not configured.
- Bot token is never read or logged in the request path.

---

### Slice 2 — `setWebhook` registration

#### Goal

The webhook is registered with Telegram at startup.

#### Tasks

1. Add `setWebhook(url: string, secretToken: string)` to `TelegramClient`.
2. Add `telegramWebhookUrl` to operator config schema.
3. Call `setWebhook` at API startup if `botToken` and `telegramWebhookUrl` are both configured.

#### Exit criteria

- `setWebhook` is called once at startup with the correct URL and secret.
- Startup does not fail if Telegram is not configured (optional feature).

#### Dev-time note

`setWebhook` requires a publicly reachable HTTPS URL. In local development this means using a tunnel (e.g. ngrok). `telegramWebhookUrl` should be omitted from `config/default.yaml` so that startup skips `setWebhook` when the value is absent — developers opt in explicitly rather than failing silently with an unreachable localhost URL.

---

### Slice 3 — Reserved name validation

#### Goal

Prevent `all` and `*` from being used as agent names.

#### Tasks

1. Add a reserved-name check in the agent create (`POST /agents`) and update (`PUT /agents/:id`) route handlers.
2. Return 400 with a clear error message when the name is `all` or `*` (case-insensitive).
3. Add validation test.

#### Exit criteria

- `POST /agents` with `name: "all"` returns 400.
- `POST /agents` with `name: "*"` returns 400.
- Existing agents are unaffected (no migration needed — users with these names just can't be targeted by name and will receive broadcast messages).

---

### Slice 4 — DB queries: agent resolution helpers

#### Goal

Efficient, ownership-scoped queries for agent resolution by name and status.

#### Tasks

1. Add `getRunningAgentsByUserId(userId: string): Promise<{ id: string; name: string }[]>` — returns agents with status in `('active', 'starting', 'paused', 'unhealthy')`.
2. Add `getAgentsByNameAndUserId(name: string, userId: string): Promise<{ id: string; name: string; status: string }[]>` — case-insensitive name match, returns all matching (handles duplicates).

#### Exit criteria

- Queries are scoped to the owning user in the WHERE clause.
- Case-insensitive match uses `ILIKE` or `lower()`.

---

### Slice 5 — Command parser

#### Goal

A pure function that parses a `/to` message text into a list of target names and a message body string.

#### Tasks

1. Implement `parseTelegramCommand(text: string): { targets: string[]; body: string } | null`.
   - Returns `null` if the message does not start with `/to` (case-insensitive).
   - Returns `{ targets: [], body: '' }` if `/to` appears alone.
   - Handles single-quoted, double-quoted, and bare (no-space) target names.
   - Handles `all` and `*` as broadcast targets.
   - Remainder after last target token is the message body.
2. Export from a dedicated `telegram-command-parser.ts` file so it can be tested in isolation.

#### Exit criteria

Parser unit tests pass for:
- `/to Agent1 buy BTC` → `{ targets: ['Agent1'], body: 'buy BTC' }`
- `/to Agent1 Agent2 check P&L` → `{ targets: ['Agent1', 'Agent2'], body: 'check P&L' }`
- `/to "DCA Bot" run` → `{ targets: ['DCA Bot'], body: 'run' }`
- `/to 'DCA Bot' Agent2 run` → `{ targets: ['DCA Bot', 'Agent2'], body: 'run' }`
- `/to all stop` → `{ targets: ['all'], body: 'stop' }`
- `/to * stop` → `{ targets: ['*'], body: 'stop' }`
- `/to` (alone) → `{ targets: [], body: '' }`
- Plain text (no `/to`) → `null`

---

### Slice 6 — Webhook handler: parse and route commands

#### Goal

Incoming Telegram messages are parsed, users resolved, agents targeted, and replies sent.

#### Tasks

1. Parse the Telegram `Update` object from the request body.
2. Resolve `userId` from `message.chat.id` via `users.telegram_chat_id`. If not found, return 200 silently.
3. If message starts with `/to`:
   a. Parse command via `parseTelegramCommand`.
   b. Resolve targets (broadcast or named lookup).
   c. For each resolved agent: check status, push to `agent:outbound:{agentId}` or collect error.
   d. Send combined reply summarising delivery and any errors.
4. If message does not start with `/to` (plain text):
   a. Get user's running agents.
   b. If exactly one → route to it, confirm "Delivered to <name>."
   c. If zero → reply "You have no running agents. Start an agent first."
   d. If multiple → reply "You have multiple running agents. Use `/to AgentName <message>` to target one."
5. Always return 200 to Telegram.

#### Exit criteria

- All syntax variants from the parser spec route correctly.
- `/to all` and `/to *` deliver to all running agents.
- Not-found and not-running agents produce clear per-target error messages in the reply.
- Plain messages route to the sole running agent or prompt the user to be explicit.
- No cross-user routing possible.

---

### Slice 7 — Tests

#### Tasks

1. Unit tests for `parseTelegramCommand` covering all syntax variants (Slice 5 exit criteria).
2. Unit tests for webhook handler: routing, broadcast, default routing, not-found, not-running, empty body, wrong secret, unregistered user.
3. Integration test: full flow (webhook → agent lookup → Redis stream write → reply sent).
4. Test reserved name rejection at agent create/update.

---

### Slice 8 — Documentation

#### Tasks

1. Create `docs/public/documentation/telegram/slash-commands.md` covering:
   - How to link your Telegram account
   - `/to` command syntax with examples (all variants)
   - Broadcast commands (`/to all`, `/to * `)
   - Default routing behaviour (single running agent)
   - What happens when an agent is stopped or not found
   - Reserved words (`all`, `*`)
   - Name collision behaviour (two agents with the same name both receive the message)
   - Error messages the bot may send and what they mean
