# More Tools Plan

> **Superseded (2026-07-17):** Items 1 and 2 (send_message email fanout) have
> been superseded by the email/messaging send capability split.
> See [007-email-and-messaging-send-capability-split](../../07/17/007-email-and-messaging-send-capability-split/001-plan.md).

## Goal

Implement the remaining agent-tooling additions described in
`000-note.md`, with email support for `send_message` following the policy in
`001-send-message-email-policy.md`.

This slice covers five capability areas:

1. memory management tools
2. time-based scheduling and reminders
3. `send_message` email fanout through Resend
4. document reading for non-HTML sources
5. durable task tracking tools

The plan keeps the initial email scope narrow:

- provider: `Resend`
- implementation: direct REST client via `fetch`
- recipient scope: verified account email only (`users.email`)
- no templates
- broker-enforced policy only

## Fixed Decisions

The following are explicit implementation decisions for this feature and are no
longer open questions.

1. Backward compatibility is not a requirement for this slice.
2. The existing `research` built-in skill will be replaced by a canonical
  `web-access` built-in skill.
3. There will be no aliasing, no dual skill registration, and no compatibility
  shim for old skill IDs.
4. The `send_message` payload will move directly to the new authoritative shape
  defined in `001-send-message-email-policy.md`.
5. Outbound message persistence will be generalized now for channel-neutral
  delivery state rather than incrementally extending the Telegram-shaped model.
6. Policy-denied email requests degrade to inbox-only and record an auditable
  denial reason.
7. `users.email` is the MVP source of the owning user's verified account email.
8. Reminder wakes will include explicit structured reminder context, not just a
  generic wake signal.
9. `read_document` is URL-only in this slice.
10. Task management in this slice is limited to create, list, and complete.

## Canonical Skill-To-Tool Mapping

This is the intended end state for skills introduced or changed by this plan.

| Skill | Tools |
|---|---|
| `base` | `set_memory`, `get_memory`, `list_memory_keys`, `delete_memory`, `send_message`, `publish_artifact` |
| `web-access` | `search_web`, `browse_url`, `read_document` |
| `task-management` | `create_task`, `list_tasks`, `complete_task`, `schedule_reminder` |

Notes:

- Email is not a skill and not a separate tool. It remains broker-enforced
  fanout behind `send_message`.
- The previous `research` skill name is intentionally retired in favor of
  `web-access`.
- `send_message` and `publish_artifact` stay in `base`; they are not duplicated
  into `web-access` or `task-management`.

## Confirmed Baseline

- Built-in skill definitions live in `packages/domain/src/skills.ts`.
- The shared tool-name manifest lives in `packages/domain/src/tools.ts`.
- Runtime tool registration happens in `apps/worker/src/tools/index.ts`.
- `send_message` protocol payload lives in `packages/domain/src/agent-protocol.ts`.
- Brokered `send_message` handling lives in `apps/worker/src/agents/agent-message-broker.ts`.
- Agent persistence and ownership resolution live in `packages/db/src/schema/agents.ts`
  and `packages/db/src/agent-repository.ts`.
- The owning user's canonical email already lives in `packages/db/src/schema/users.ts`.
- Existing outbound message persistence is in
  `packages/db/src/schema/agent-outbound-messages.ts`.
- Operator alerting config already has a pattern for provider-specific channel
  clients via `packages/domain/src/config/schema.ts`, `config/default.yaml`,
  `apps/worker/src/config.ts`, and `apps/worker/src/alerting/telegram-client.ts`.
- Existing memory state is stored in Redis via `apps/worker/src/tools/memory.ts`.
- Existing web-access tools are implemented in `apps/worker/src/tools/web-access.ts`.

## Design Decisions To Carry Into Implementation

1. Email remains part of `send_message`; do not create `send_email` or
   `send_telegram`.
2. Email is not a skill. It is broker-governed fanout for a base tool.
3. The runtime must not infer email permission from prompt text on every tick.
   The create/update path resolves explicit user intent into stored agent config.
4. Routine messages are inbox-only, even when email policy is enabled.
5. Resend is integrated as a small provider abstraction using direct `fetch`,
   mirroring the existing Telegram client style.
6. Task and reminder state should start as agent-private state, not user-facing
   first-class product objects.
7. The end-state skill name is `web-access`, not `research`.
8. This implementation targets the clean end state directly; do not add
   transition logic for old skill names or old payload shapes.

## Plan

1. Add shared domain contracts for the new tools and `send_message` payload fields.
   Files: `packages/domain/src/tools.ts`, `packages/domain/src/agent-protocol.ts`, `packages/domain/src/skills.ts`, `packages/domain/src/index.ts`.
   Change:
   - Extend `KNOWN_AGENT_TOOL_NAMES` with `get_memory`, `list_memory_keys`,
     `delete_memory`, `create_task`, `list_tasks`, `complete_task`,
     `schedule_reminder`, and `read_document`.
   - Extend `SendMessagePayloadSchema` with `messageClass` and `emailDelivery`
     exactly as defined in `001-send-message-email-policy.md`.
   - Extend `BASE_SKILL.requiredTools` and its instructions with the memory CRUD
     tools.
   - Add a new built-in `TASK_MANAGEMENT_SKILL` for `create_task`, `list_tasks`,
     `complete_task`, and `schedule_reminder`.
   - Replace `RESEARCH_SKILL` with a canonical `WEB_ACCESS_SKILL` that exposes
     `search_web`, `browse_url`, and `read_document`.
   - Update exported system-skill and preset wiring to use the new end-state
     skill IDs directly, with no dual registration.
   Dependency: none.
   Decision:
   - No backward-compatibility shim will be added for the previous `research`
     skill ID.

2. Add agent notification-policy persistence and API exposure for email eligibility.
   Files: `packages/db/src/schema/agents.ts`, `packages/db/src/agent-repository.ts`, `apps/api/src/routes/agents.ts`, `apps/api/src/routes/agent-interactivity.ts`, `apps/api/src/routes/agent-config-helpers.ts`, database migration files under `packages/db/drizzle/`.
   Change:
   - Add `notificationPolicy` JSONB to the `agents` table with the shape from
     `001-send-message-email-policy.md`.
   - Thread `notificationPolicy` through `InsertAgent`, `UpdateAgent`, and
     decorated API responses.
   - Extend create/update request schemas so the resolved policy can be stored
     explicitly.
   - Keep `enabledAt` server-written.
   Dependency: step 1 for type naming consistency.
   Decision:
   - Use `users.email` as the verified-account-email source for MVP.

3. Add Resend operator config and a provider-neutral email client abstraction.
   Files: `packages/domain/src/config/schema.ts`, `apps/worker/src/config.ts`, `config/default.yaml`, optionally env documentation files if present, new `apps/worker/src/alerting/email-client.ts`, new `apps/worker/src/alerting/resend-email-client.ts`.
   Change:
   - Add an `alerts.email` config block with the minimum fields needed for Resend,
     for example `apiKey`, `fromEmail`, and optional `replyToEmail` and timeout.
   - Add env override support in `apps/worker/src/config.ts` only for provider
     secrets/scalars that justify overrides.
   - Introduce a small `EmailClient` interface and a `ResendEmailClient`
     implementation using direct `fetch`.
   - Keep the client response model small and symmetric with
     `TelegramClient.sendText()`.
   Dependency: none.
   Decision:
   - Keep only provider secrets/simple scalars in env overrides; keep structured
     policy in YAML.

4. Extend outbound message persistence for multi-channel delivery state.
   Files: `packages/db/src/schema/agent-outbound-messages.ts`, `packages/db/src/agent-repository.ts`, database migration files under `packages/db/drizzle/`.
   Change:
   - Evolve the current Telegram-specific delivery fields into a shape that can
     record inbox persistence plus email and Telegram outcomes independently.
   - Persist enough metadata to distinguish `feed_only`, `email_sent`,
     `email_skipped_policy`, `email_skipped_not_configured`,
     `email_skipped_no_verified_recipient`, and `email_failed_provider`.
   - Add repository methods for marking email delivery success/failure/skip
     without losing existing Telegram support.
   Dependency: step 2 for policy storage, step 3 for provider abstraction.
   Decision:
   - Generalize the table now. Do not bolt email onto the old Telegram-specific
     schema.

5. Implement broker-side `send_message` email policy enforcement and fanout.
   Files: `apps/worker/src/agents/agent-message-broker.ts`, `packages/db/src/agent-repository.ts`, `apps/worker/src/index.ts`.
   Change:
   - Inject the email client into the worker bootstrap alongside `TelegramClient`.
   - Extend `handleSendMessage()` to:
     - validate `messageClass` and `emailDelivery`
     - persist the inbox record first
     - resolve the owning user's account email via repository helper
     - enforce the policy in `001-send-message-email-policy.md`
     - send email via Resend only for eligible `alert` or `reminder` messages
     - record skip/failure/sent outcomes in outbound message metadata
   - Preserve existing send-message rate limiting and add a stricter secondary
     broker-side limiter for email fanout.
   Dependency: steps 2, 3, and 4.
   Decision:
   - Policy-denied email requests degrade to inbox-only and record denial
     metadata.

6. Add memory-management tool implementations on top of the existing Redis hash.
   Files: `apps/worker/src/tools/memory.ts`, `apps/worker/src/tools/index.ts`, `packages/domain/src/tools.ts`, relevant tests under `apps/worker/src/tools/` or nearby worker tests.
   Change:
   - Implement `get_memory`, `list_memory_keys`, and `delete_memory` using the
     same `agent:memory:{agentId}` hash used by `set_memory`.
   - Keep values JSON-decoded/encoded consistently with the existing API read path
     in `apps/api/src/routes/agent-interactivity.ts`.
   Dependency: step 1 for tool-name registration.
   Decision:
   - `get_memory` returns a non-error miss result such as `{ ok: true, found: false }`.

7. Add task-tracking tools backed by Redis.
   Files: new `apps/worker/src/tools/tasks.ts`, `apps/worker/src/tools/index.ts`, `packages/domain/src/tools.ts`, `packages/domain/src/skills.ts`, relevant worker tests.
   Change:
   - Create `create_task`, `list_tasks`, and `complete_task` as agent-private
     durable state.
   - Store tasks under a dedicated Redis keyspace such as `agent:tasks:{agentId}`
     rather than overloading memory keys.
   - Give tasks stable IDs, timestamps, status, title, and optional notes or due
     metadata.
   Dependency: step 1.
   Decision:
   - Keep v1 to create/list/complete only.

8. Add reminder scheduling as a worker-owned wake source.
   Files: new `apps/worker/src/tools/reminders.ts` or `tasks.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/agents/instance-event-publisher.ts`, possibly new worker-side reminder coordinator/loop files, `packages/domain/src/agent-protocol.ts`, relevant tests.
   Change:
   - Implement `schedule_reminder` as persisted worker-owned state, not an
     in-container timer.
   - Reuse the existing wake model (`agent:outbound:{agentId}`, `agent.market.wake`,
     `wakePending`, `nextTickDueAt`) to trigger reminder-driven ticks.
   - Emit both a wake and a structured reminder event payload so the agent can
     see why it woke.
   - Integrate reminders with `send_message` by allowing reminder messages to set
     `messageClass: 'reminder'` and optionally `emailDelivery: 'if_allowed'`.
   Dependency: steps 1, 5, and 7.
   Decision:
   - Start with one-shot absolute datetimes only. Do not implement recurrence,
     snooze, or timezone rules in this slice.

9. Add `read_document` to the `web-access` tool surface.
   Files: `apps/worker/src/tools/web-access.ts`, `apps/worker/src/tools/index.ts`, `packages/domain/src/tools.ts`, `packages/domain/src/skills.ts`, relevant worker tests.
   Change:
   - Implement `read_document` in the existing web-access module rather than
     creating a separate transport stack.
   - Start with PDF support only; use content-type sniffing and explicit rejection
     for unsupported document types.
   - Reuse the existing capability, response-size, timeout, SSRF, and fetch-budget
     structure already present for `browse_url`.
   Dependency: step 1.
   Decision:
   - `read_document` is URL-only in this slice.

10. Wire the new tools into runtime visibility, fallback skill resolution, and startup assertions.
    Files: `apps/worker/src/tools/index.ts`, `apps/worker/src/agent.ts`, `apps/worker/src/runtime-tool-visibility.ts` and tests if dependency classifications change, `packages/db/src/agent-runtime-descriptor.ts`, functional skill reseed helpers/tests under `apps/api/src/__tests__/functional/`.
    Change:
    - Register the new tool modules.
    - Replace the old `research` built-in skill references with `web-access`
      across runtime fallback resolution, skill reseeding, and runtime
      descriptors.
    - Ensure known-tool manifest, built-in-skill validation, and DB reseed helpers
      stay in sync.
    - Keep reminder/task tools available during DB outages when backed only by
      Redis.
    Dependency: steps 1, 6, 7, 8, and 9.

11. Add focused test coverage and rollout validation.
    Files: worker unit tests near `apps/worker/src/tools/`, broker tests near
    `apps/worker/src/agents/`, API tests near `apps/api/src/routes/`, DB/repository
    tests under `packages/db/src/`, and this feature folder.
    Change:
    - Add unit tests for memory CRUD, task CRUD, reminder scheduling decisions,
      `read_document`, Resend client request/response handling, and broker email
      policy enforcement.
    - Add repository tests for resolving the owning user's email and recording
      multi-channel delivery outcomes.
    - Add API tests for create/update agent notification policy acceptance.
    - Run `pnpm lint` and targeted tests for touched slices.
    Dependency: all prior implementation steps.

## Test Strategy

### Unit tests

- `apps/worker/src/tools/memory*.test.ts`
  - `get_memory` returns decoded value for an existing key
  - `list_memory_keys` returns stable key ordering
  - `delete_memory` removes one or more keys and reports misses cleanly

- `apps/worker/src/tools/tasks*.test.ts`
  - create/list/complete round-trip
  - complete on missing task behaves deterministically

- `apps/worker/src/tools/web-access*.test.ts`
  - `read_document` rejects unsupported content types
  - `read_document` enforces byte/time budgets and URL restrictions

- `apps/worker/src/alerting/resend-email-client*.test.ts`
  - maps successful Resend response to normalized result
  - maps provider/network failures to stable error codes

- `apps/worker/src/agents/agent-message-broker*.test.ts`
  - routine messages never email
  - alert/reminder messages email only when agent policy allows it
  - no verified email or missing provider config records a skip, not silent loss

### Repository / DB tests

- `packages/db/src/agent-repository*.test.ts`
  - resolves owning user email from agent ID
  - stores/reads `notificationPolicy`
  - records generalized delivery metadata correctly

### API tests

- `apps/api/src/routes/agents*.test.ts`
  - create/update accepts notification policy payload
  - decorated response returns the stored policy consistently

### Validation commands

- `pnpm lint`
- targeted vitest commands for worker, API, and DB tests touching this slice

## Rollout Notes

1. Ship the schema and repository changes before the broker fanout logic.
2. Keep email fanout disabled by default in operator config.
3. Treat `users.email` as the verified-account-email source for MVP.
4. Start with plain text or minimal HTML generated directly in code; do not add
   a template system.
5. Keep reminder scheduling one-shot only in this plan.

## Exit Criteria

- `send_message` supports broker-enforced Resend email fanout for eligible alert
  and reminder messages only.
- email is impossible for routine messages.
- the broker resolves only the owning user's account email.
- memory management tools are implemented and registered.
- task management tools are implemented and registered.
- `schedule_reminder` is implemented as worker-owned persisted state using the
  existing wake model.
- `read_document` supports at least PDF URL reading with bounded fetch behavior.
- built-in skill definitions, tool catalog, runtime registry, and functional
  reseed helpers all reflect the canonical `base`, `web-access`, and
  `task-management` mapping with no backward-compatibility shim.
- focused tests and `pnpm lint` pass.