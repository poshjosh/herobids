# Basic Telegram Agent Slash Commands

## Status

`draft`

## Purpose

Add a small, explicit Telegram command surface for agent discovery, status checks, and basic lifecycle control without bypassing the existing ownership and lifecycle rules already enforced by the API.

## Scope

### In scope

1. Add a Telegram command router on top of the existing webhook path in `apps/api/src/routes/agent-interactivity.ts`.
2. Preserve the existing `/to` message-routing behavior.
3. Add basic read commands for help, listing, and status.
4. Add basic lifecycle commands for start, pause, resume, and stop.
5. Extract the current lifecycle mutations from `apps/api/src/routes/agents.ts` into a shared backend service/helper so Telegram and HTTP use the same logic.
6. Register supported Telegram commands with the Telegram Bot API so they show up in the client command picker.
7. Add focused tests for parsing, authorization/ownership, lifecycle transitions, and user-facing responses.
8. Add user-facing documentation for command syntax and limits.

### Out of scope

1. Bot lifecycle commands.
2. Inline-button confirmation flows.
3. Rich Telegram menus, custom keyboards, or conversational state machines.
4. Multi-step command sessions.
5. Per-agent Telegram bot identities.
6. Full natural-language agent control through Telegram beyond the existing `/to` flow.

## Problem Statement

Telegram already works as a message transport for agents, but it does not yet expose a minimal operational command set for the owning user. The main missing piece is not transport; it is command routing and safe reuse of agent lifecycle logic, which today lives directly inside HTTP route handlers.

The current shape creates three implementation constraints:

1. `/to` already occupies the existing command parser and must keep working.
2. Agent lifecycle rules already exist and should not be reimplemented separately in the Telegram webhook.
3. Telegram `/start` is already part of the account-binding flow, so a lifecycle `/start` command needs explicit handling to avoid breaking onboarding.

## Commands Planned

1. `/help`
2. `/agents`
3. `/status`
4. `/status <agent name>`
5. `/start <agent name>`
6. `/pause <agent name>`
7. `/resume <agent name>`
8. `/stop <agent name>`

## Command Semantics

### Read commands

1. `/help`
   Returns the supported command list with short usage examples.
2. `/agents`
   Returns all caller-owned agents with current status, one per line.
3. `/status`
   Returns a compact summary of all caller-owned agents, including lightweight details such as last session state and pause reason when available.
4. `/status <agent name>`
   Returns status for the matching agent name, using case-insensitive exact matching and quoted-name support for spaces.

### Lifecycle commands

1. `/start <agent name>`
   Starts the matching agent(s) using the same validation and state transition rules as `POST /agents/:id/start`.
   If multiple caller-owned agents share the same case-insensitive exact name, all matching agents are started.
2. `/pause <agent name>`
   Pauses an active or starting agent using the same rules as `POST /agents/:id/pause`.
3. `/resume <agent name>`
   Resumes a paused agent using the same rules as `POST /agents/:id/resume`.
4. `/stop <agent name>`
   Stops a non-stopped agent immediately using the same rules as `POST /agents/:id/stop`.

### `/start` compatibility rule

To avoid breaking Telegram onboarding, the first slice should treat exact `/start` with no agent argument as onboarding/help, not as a lifecycle action. Lifecycle start only runs when the command includes an agent target, for example `/start Momentum`.

## Target UX

Examples:

```text
/help
/agents
/status
/status "DCA Bot"
/start Momentum
/pause Momentum
/resume Momentum
/stop "DCA Bot"
```

Example responses:

```text
Available commands:
/agents - list your agents
/status [agent] - show agent status
/start <agent> - start a stopped agent
/pause <agent> - pause a running agent
/resume <agent> - resume a paused agent
/stop <agent> - stop an agent
/to <agent> <message> - send a message to an agent
```

```text
Momentum: active
DCA Bot: paused
Swing Trader: stopped
```

```text
Started Momentum.
```

```text
Cannot resume Momentum because it is not paused. Current status: active.
```

## Design Constraints

1. No self-HTTP calls from the webhook handler back into the API.
2. Ownership must be enforced exactly as it is for the existing HTTP routes.
3. Telegram commands must remain idempotent where the HTTP endpoints are idempotent.
4. User-visible responses should be short, deterministic, and safe to retry.
5. Unknown commands should reply with help rather than failing silently.
6. `/to` reply-threading and plain-message routing must keep working unchanged.

## Implementation Approach

### Slice 1 — Introduce a generic Telegram command router

#### Goal

Separate slash-command detection from the current `/to` parser so the webhook can dispatch multiple explicit commands cleanly.

#### Tasks

1. Add a command router that detects:
   - `/help`
   - `/agents`
   - `/status`
   - `/start`
   - `/pause`
   - `/resume`
   - `/stop`
   - `/to`
2. Keep `/to` delegated to the existing parser and routing logic.
3. Add a small shared argument parser for command targets with support for:
   - case-insensitive command names
   - quoted agent names
   - exact name matching after normalization
4. Make exact bare `/start` return onboarding/help text when no target argument is present.

#### Exit criteria

1. The webhook distinguishes command messages from plain text deterministically.
2. Existing `/to` behavior and reply-threading behavior still pass unchanged tests.
3. Unknown slash commands get a short help response.

### Slice 2 — Extract shared agent lifecycle service

#### Goal

Move lifecycle state transitions out of the route handlers so both HTTP routes and the Telegram webhook can call one implementation.

#### Tasks

1. Extract shared functions or a service from `apps/api/src/routes/agents.ts` for:
   - startAgent
   - pauseAgent
   - resumeAgent
   - stopAgent
2. Keep the current DB transaction behavior and result shapes aligned with existing route semantics.
3. Return typed results instead of throwing.
4. Update the HTTP routes to call the shared service.

#### Exit criteria

1. The HTTP agent lifecycle routes still behave exactly as they do today.
2. The Telegram webhook can call the same shared implementation directly.
3. No duplicated lifecycle mutation logic remains in the webhook handler.

### Slice 3 — Add read commands

#### Goal

Provide safe, high-signal commands that let users discover their agents and see current state before any lifecycle changes.

#### Tasks

1. Implement `/help`.
2. Implement `/agents`.
3. Implement `/status` with two forms:
   - no target: summarize all caller-owned agents
   - one target: show one agent's status
4. Reuse the same agent ownership scope as the existing routes.
5. Format output as short plain text lines suitable for Telegram.

#### Exit criteria

1. A bound user can list their agents and statuses from Telegram.
2. An unbound chat does not gain any visibility into agents.
3. Quoted agent names with spaces work for `/status <agent>`.

### Slice 4 — Add lifecycle commands

#### Goal

Expose minimal agent control from Telegram using the same rules already enforced by the HTTP API.

#### Tasks

1. Implement `/start <agent>`.
2. Implement `/pause <agent>`.
3. Implement `/resume <agent>`.
4. Implement `/stop <agent>`.
5. Map service results to compact Telegram replies, for example:
   - started
   - paused
   - resumed
   - stopped
   - not found
   - invalid current status
   - model selection incomplete
6. Keep commands case-insensitive and agent lookup scoped to the owning user.

#### Exit criteria

1. Telegram lifecycle commands produce the same state transitions as the HTTP routes.
2. Repeating an idempotent command returns a stable response.
3. Ownership violations never leak whether another user's agent exists.

### Slice 5 — Register Telegram bot commands

#### Goal

Expose the supported slash commands through the Telegram command picker.

#### Tasks

1. Extend `TelegramClient` with a `setMyCommands` method.
2. Register the command list at startup when Telegram is configured.
3. Keep startup non-fatal if Telegram registration fails, but log loudly.

#### Exit criteria

1. Telegram shows the supported commands in the bot UI.
2. Startup logs clearly indicate success or failure.

### Slice 6 — Documentation and tests

#### Goal

Lock behavior down with focused coverage and publish the operator/user contract.

#### Tasks

1. Add parser tests for slash command detection and quoted target parsing.
2. Add webhook tests for:
   - unbound chat behavior
   - `/help`
   - `/agents`
   - `/status`
   - `/start <agent>`
   - `/pause <agent>`
   - `/resume <agent>`
   - `/stop <agent>`
   - unknown command handling
   - exact `/start` onboarding behavior
3. Add route-level tests to prove the refactor into a shared lifecycle service does not change HTTP behavior.
4. Add user-facing documentation for Telegram commands.

#### Exit criteria

1. Existing `/to` tests still pass.
2. New command coverage exists for both happy paths and state-conflict paths.
3. The user documentation matches the implemented command set.

## Files Expected To Change

### API

1. `apps/api/src/routes/agent-interactivity.ts`
2. `apps/api/src/routes/telegram-command-parser.ts` or a new more general Telegram command parser/router module
3. `apps/api/src/routes/telegram-command-parser.test.ts`
4. `apps/api/src/routes/agent-interactivity.test.ts`
5. `apps/api/src/routes/agents.ts`
6. `apps/api/src/__tests__/functional/helpers.ts` if shared boot wiring changes are needed

### Shared service/helper

1. `apps/api/src/services/agent-lifecycle-service.ts` or similar new module

### Worker / Telegram client

1. `apps/worker/src/alerting/telegram-client.ts`
2. `apps/worker/src/alerting/alert-dispatcher.test.ts`
3. `apps/worker/src/index.ts` if command registration is wired there rather than API startup

### Documentation

1. `docs/public/documentation/telegram/slash-commands.md` or the current public Telegram documentation location

## Risks

1. Overloading `/start` may create user confusion if onboarding and lifecycle semantics are not kept distinct.
2. Refactoring lifecycle logic out of routes can accidentally change HTTP behavior if result mapping is not preserved exactly.
3. Telegram command retries can duplicate requests if responses are not idempotent and compact.
4. Long agent lists can exceed comfortable Telegram message length if `/agents` output is not kept concise.

## Open Questions

All open questions are resolved:

1. Exact bare `/start` remains onboarding/help; lifecycle start is only `/start <agent>`.
2. `/start <agent>` starts every matching caller-owned agent if duplicate names exist.
3. `/status` includes lightweight details such as last session state and pause reason when available.
4. `/stop` executes immediately.
5. Telegram lifecycle control remains agent-only in this slice.
6. `/agents` includes all caller-owned agents, including stopped ones.

## Recommended First Implementation Order

1. Slice 1
2. Slice 2
3. Slice 3
4. Slice 4
5. Slice 6
6. Slice 5

This order keeps the risky refactor local, validates read-only commands before destructive ones, and leaves Telegram command registration as the final integration step rather than a blocker.