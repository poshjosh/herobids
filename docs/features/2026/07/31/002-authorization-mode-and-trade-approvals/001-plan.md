## Plan: Authorization Mode And Trade Approvals

**Status:** Ready for implementation
**Scope:** Agent-direct trading only. Bot approval-gating is explicitly deferred.

**TL;DR:** Add a user-configured `authorizationMode` to agent config, introduce a new creator-facing `trading-assistant` preset that includes trading skill but excludes bot management, make `submit_decision` return `pending_approval` instead of immediate execution when `authorizationMode = 'approval_required'`, persist first-class approval records with short human-safe codes, and let users resolve them through web UI and Telegram slash commands. All chat/help/docs should prefer `/yes <code>` and `/no <code>`; code-less `/yes` and `/no` are accepted only when the user has exactly one unresolved approval.

---

## Current Code Truth (verified)

Do not re-diagnose these during implementation. They are confirmed facts about the current code.

1. **Trading preset currently bundles direct trading and bot autonomy.**
   `SKILL_PRESET_MAP` in [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts) maps `trading` to `['bot-management', 'trading']`, while `direct-trading` maps to `['trading']`.

2. **The web UI mirrors that preset model and does not yet know about `trading-assistant`.**
   `SkillPresetId` and `SKILL_PRESET_SKILL_IDS` in [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts) currently only support `trading`, `personal-assistant`, and `custom`.

3. **Unified agent config does not currently express execution authorization.**
   `UnifiedAgentConfigSchema` in [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts) includes `capabilityMode`, `hybridMode`, `technical`, `execution`, `risk`, and platform-assessment fields, but no `authorizationMode`.

4. **API response enrichment does not surface authorization state today.**
   `enrichAgentResponse()` in [apps/api/src/routes/agents.ts](../../../../../apps/api/src/routes/agents.ts) currently returns `technical`, `strategyPreset`, `strategyPresetName`, `capabilityMode`, `hybridMode`, and `platformAssessment`, but no authorization field.

5. **`submit_decision` always publishes immediately into the execution pipeline and only understands accepted/rejected/error outcomes.**
   In [apps/worker/src/tools/trading.ts](../../../../../apps/worker/src/tools/trading.ts), `submit_decision` publishes `AGENT_MESSAGE_TYPES.DECISION_SUBMIT`, waits for a synchronous Redis reply, and only handles `accepted`, `rejected`, or generic error states.

6. **The agent decision handler has no pending-approval branch today.**
   `AgentDecisionHandler.handleDecisionSubmit()` in [apps/worker/src/agents/agent-decision-handler.ts](../../../../../apps/worker/src/agents/agent-decision-handler.ts) validates the runtime session, resolves execution context, and proceeds directly toward execution acceptance/rejection. There is no stored approval object or human-approval pause state.

7. **The `decisions` table is append-only and has no approval lifecycle fields.**
   [packages/db/src/schema/decisions.ts](../../../../../packages/db/src/schema/decisions.ts) stores executed strategic intent for audit and replay. It has no status column for `pending approval`, no short code, and no user-resolution metadata. This should not be overloaded with approval workflow state.

8. **Bot-management is a real execution loophole for any “non-autonomous trading” preset.**
   `create_bot` in [apps/worker/src/tools/bots.ts](../../../../../apps/worker/src/tools/bots.ts) publishes `create_and_start`, not a draft. A preset that includes `bot-management` can still cause autonomous market-affecting behavior even if `submit_decision` is approval-gated.

9. **Telegram slash commands already have a central parser and router.**
   [apps/api/src/routes/telegram-slash-commands.ts](../../../../../apps/api/src/routes/telegram-slash-commands.ts) defines the slash-command registry/help text, and [apps/api/src/routes/agent-interactivity.ts](../../../../../apps/api/src/routes/agent-interactivity.ts) routes parsed commands before falling back to plain `/to` or freeform messaging.

10. **User-to-agent messaging already exists, but it is not the right place for authoritative approval actions.**
    `POST /agents/:id/message` in [apps/api/src/routes/agent-interactivity.ts](../../../../../apps/api/src/routes/agent-interactivity.ts) forwards plain user text into `agent:outbound:{agentId}` as `user.message`. That channel is suitable for discussion, not for the final authoritative approval command that causes market execution.

11. **Agent-to-user messaging already exists and can carry approval notifications or follow-up commentary.**
    `send_message` in [apps/worker/src/tools/messaging.ts](../../../../../apps/worker/src/tools/messaging.ts) queues platform-delivered user messages. The approval request itself should be platform-authored, but the agent may still send optional narrative context.

12. **The runtime and activity feed already track decisions and messages, so approval-specific events can slot into existing surfaces.**
    [apps/worker/src/runtime-composition.ts](../../../../../apps/worker/src/runtime-composition.ts) records decision/message timeline events, and [apps/api/src/routes/agent-activity-mapper.ts](../../../../../apps/api/src/routes/agent-activity-mapper.ts) already maps decision and message protocol types into user-visible activity rows.

13. **The current edit UI infers the selected preset from skill IDs alone.**
   `resolvePresetFromSkillIds()` in [apps/web/src/features/agents/EditAgentModal.tsx](../../../../../apps/web/src/features/agents/EditAgentModal.tsx) only recognizes the current fixed skill arrays. If two product presets share the same skill IDs, the current edit flow cannot distinguish them without an explicit persisted preset identifier.

14. **Agent direct-execution fallback is paper-only when no running actor exists.**
   [apps/worker/src/agents/agent-intake-resolver.ts](../../../../../apps/worker/src/agents/agent-intake-resolver.ts) explicitly rejects the fallback path unless the agent is in `paper` mode. Live and shadow agents depend on the running actor/registry path for safe execution context.

---

## Goals

1. Add a new creator-facing preset called `trading-assistant` that uses the trading skill surface without bot-management.
2. Add a user-configured `authorizationMode` that determines whether agent-direct trade proposals execute immediately or require explicit user approval.
3. Make the agent aware of `authorizationMode` through structured config, prompt/context, and `submit_decision` tool semantics.
4. Introduce a first-class approval object with short, human-safe codes and a clear lifecycle.
5. Support approval and rejection from both web UI and Telegram slash commands.
6. Prefer and encourage `/yes <code>` and `/no <code>` everywhere in chat/help/documentation; accept code-less `/yes` and `/no` only when exactly one unresolved approval exists for the user.
7. Keep the platform, not the agent, as the authoritative owner of approval resolution and execution handoff.
8. Keep the direct-trading path fully backward-compatible for existing agents using the default authorization mode.
9. Keep approval resolution behavior explicit and safe when the agent has no executable runtime context at the moment the user approves.

## Non-Goals

- Do **not** approval-gate bot lifecycle actions in this feature slice.
- Do **not** include `bot-management` in the new `trading-assistant` preset.
- Do **not** infer approval from freeform chat text like `yes`, `ok`, or `go ahead`.
- Do **not** require users to memorize or type full approval IDs.
- Do **not** support in-place editing of pending proposals in v1; users approve or reject as-is.
- Do **not** redesign `capabilityMode`, `hybridMode`, or the existing mechanical/LLM/hybrid decision-making model.
- Do **not** move operator policy into user config or vice versa.

---

## Design Decisions (closed)

1. **`authorizationMode` is a user/agent config field, not a new capability family or role architecture.**
   It belongs in unified agent config because it is creator-selected runtime policy, not deploy-time operator config.

2. **`trading-assistant` is a product preset, not a new deep trading stack.**
   It should reuse the existing trading capability family and tooling, while changing authorization behavior and preset composition.

3. **`trading-assistant` maps to trading skill only.**
   In v1 it must not include `bot-management`, because `create_bot` currently creates autonomous traders immediately.

4. **Approval state is modeled as a new first-class object, not as a state on `decisions`.**
   The `decisions` table is append-only audit data for submitted/executed intent. Pending user approval is a separate lifecycle with different ownership and timing.

5. **The authoritative approval action is platform-owned.**
   Slash commands and UI buttons resolve approval records directly in the platform. They do not go through the agent message stream.

6. **`/yes <code>` and `/no <code>` are the primary UX.**
   All chat copy, help text, notifications, and documentation should prefer codeful commands. Code-less `/yes` and `/no` are convenience fallbacks only when the user has exactly one unresolved approval.

7. **Short codes must be human-safe.**
   Use a 6-character uppercase code from an unambiguous alphabet such as `23456789ABCDEFGHJKMNPQRTVWXYZ`, excluding visually confusing characters like `0`, `O`, `I`, `L`, and lowercase forms.

8. **Approval execution must not depend on the original runtime session remaining active.**
   Once the platform stores a pending approval, approving it later should execute against the agent’s current valid trading context, not fail just because the original agent container restarted.

9. **Approval expiry is required and must not be a magic number.**
   The TTL should be defined in operator config, not hardcoded in business logic.

10. **`authorizationMode` is only meaningful for trading-capable agents.**
   The API should reject explicit `authorizationMode` values when the submitted skill set has no `trading` capability family, similar to how execution mode is validated today.

11. **Preset identity must not be inferred from skill IDs alone once `trading-assistant` exists.**
   Persist an explicit creator-facing preset identifier such as `unifiedConfig.metadata.skillPresetId`, and return it in agent API responses so create/edit UI can round-trip `trading`, `direct-trading`, and `trading-assistant` without ambiguity.

12. **Approval execution follows the same execution-context resolution rules as direct submissions.**
   Use the running actor path when available. If no actor exists, only `paper` mode may use the active-grant fallback. `shadow` and `live` approvals fail closed unless a running execution actor is available.

13. **A failed approval attempt caused by missing execution context does not consume the approval.**
   If the user tries to approve while the agent is stopped, disconnected, or otherwise lacks executable context, the approval remains `pending` and the platform returns a recoverable error telling the user what to fix.

14. **Approval events are not a new wake source.**
   Approval created/approved/rejected/expired events may appear in activity feeds and runtime timelines, but they must not introduce a new `agent.wake` source. If the agent learns about them later, it does so via the normal next tick or an existing user-message channel, not a new wake taxonomy entry.

15. **The web approvals list is canonical; Telegram delivery is additive.**
   Approval requests must remain visible and actionable in the web app even when Telegram is unbound or delivery fails.

16. **Short codes are user-scoped convenience tokens, not globally unique identifiers.**
   The canonical approval identifier is `approvalId`. Slash-command resolution uses `(userId, shortCode)`, where `userId` comes from authenticated web identity or the Telegram-bound user.

17. **Short codes must never be reused for the same user.**
   Even after an approval is resolved or expired, its short code stays historically reserved for that user. This prevents an old Telegram message or screenshot from ambiguously pointing at a newer approval.

---

## Proposed Data Model

Add a new table, tentatively `decision_approvals`, under [packages/db/src/schema](../../../../../packages/db/src/schema), with a matching Drizzle migration.

Suggested fields:

```ts
id: text('id').primaryKey(),
shortCode: text('short_code').notNull(),
userId: text('user_id').notNull(),
agentId: text('agent_id').notNull(),
actorType: text('actor_type').notNull().default('agent'),
actorId: text('actor_id').notNull(),
venueAccountId: text('venue_account_id').notNull(),
authorizationModeSnapshot: text('authorization_mode_snapshot').notNull(),
status: text('status').notNull(), // pending | approved | rejected | expired
executionStatus: text('execution_status'), // accepted | rejected | error | null
instrumentId: text('instrument_id').notNull(),
intent: text('intent').notNull(),
targetSize: numeric('target_size').notNull(),
limitPrice: numeric('limit_price'),
stopLoss: numeric('stop_loss'),
takeProfit: numeric('take_profit'),
confidence: numeric('confidence'),
rationaleSummary: text('rationale_summary').notNull(),
contextHash: text('context_hash'),
proposedPayload: jsonb('proposed_payload').$type<Record<string, unknown>>().notNull(),
decisionId: text('decision_id'),
planId: text('plan_id'),
resolvedByUserId: text('resolved_by_user_id'),
resolvedAt: timestamp('resolved_at', { withTimezone: true }),
resolutionSource: text('resolution_source'), // web | telegram_yes | telegram_no | api
lastResolutionAttemptAt: timestamp('last_resolution_attempt_at', { withTimezone: true }),
lastResolutionErrorCode: text('last_resolution_error_code'),
lastResolutionErrorMessage: text('last_resolution_error_message'),
expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
```

Indexes:

- `idx_decision_approvals_user_status_created_at` on `(userId, status, createdAt)`
- `idx_decision_approvals_agent_status_created_at` on `(agentId, status, createdAt)`
- unique index on `(userId, shortCode)`

Notes:

- `approvalId` remains the canonical object identifier. `shortCode` is only the human-facing lookup token.
- `shortCode` is user-scoped, not globally unique. All code-based lookups must include the authenticated or bound `userId`.
- Use 6 characters by default. The goal is typing clarity plus ample per-user space, not global-scale uniqueness.
- Store the original proposal payload so approval execution is deterministic and auditable.
- Keep approval status and execution status separate so “user approved, but execution later failed risk checks” is representable.
- Record the last failed approval-attempt error without consuming the approval, so users can start the agent or restore trading context and try again.
- Do not use a partial uniqueness rule such as “unique only among pending approvals.” Codes must not be reused for the same user after resolution or expiry.
- Code lookups must always be scoped by authenticated or bound `userId`; foreign or invalid codes should return the same generic “not found or not accessible” response.

---

## Operator Config

Add a small operator-config section for approval workflow policy in [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts) and `config/default.yaml`.

Suggested shape:

```ts
agentApprovals: z.object({
  ttlMs: z.number().int().min(60_000).default(86_400_000),
   resolveRateLimitPerMinute: z.number().int().min(1).default(20),
}).default({}),
```

Notes:

- `ttlMs` is policy and must not be hardcoded.
- `resolveRateLimitPerMinute` applies to approval-resolution attempts from slash commands and any future code-based API helpers.
- No user-facing configurability is needed in v1.
- The approval-code alphabet and length can stay code constants initially unless product requirements demand operator control.

---

## Config And Preset Changes

### Change 1 — Add `authorizationMode` to unified agent config

**Files:**
- [packages/domain/src/config/schema.ts](../../../../../packages/domain/src/config/schema.ts)
- [packages/domain/src/config/schema.test.ts](../../../../../packages/domain/src/config/schema.test.ts)
- [packages/domain/src/config/index.ts](../../../../../packages/domain/src/config/index.ts)
- [apps/api/src/routes/agent-config-helpers.ts](../../../../../apps/api/src/routes/agent-config-helpers.ts)
- agent route tests covering config validation

**What:**

1. Add:

```ts
export const AuthorizationModeSchema = z.enum(['direct', 'approval_required']);
```

2. Extend `UnifiedAgentConfigSchema` with:

```ts
authorizationMode: AuthorizationModeSchema.default('direct'),
```

3. Export the inferred type.
4. Add tests proving:
   - default is `direct`
   - `approval_required` is accepted
   - invalid strings are rejected
5. Add API-side validation mirroring execution-mode rules:
   - explicit `authorizationMode` is rejected for non-trading agents
   - trading-capable agents default to `direct` when omitted

**Why:** this is the canonical creator-controlled runtime policy for whether agent-direct proposals execute immediately or require human approval.

### Change 2 — Add the `trading-assistant` preset

**Files:**
- [packages/domain/src/skills.ts](../../../../../packages/domain/src/skills.ts)
- [apps/web/src/features/agents/agent-display.ts](../../../../../apps/web/src/features/agents/agent-display.ts)
- [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx)
- [apps/web/src/features/agents/EditAgentModal.tsx](../../../../../apps/web/src/features/agents/EditAgentModal.tsx)
- related web tests around preset mapping

**What:**

1. Extend `SKILL_PRESET_MAP` with:

```ts
'trading-assistant': ['trading'],
```

2. Extend the web `SkillPresetId` union and preset-resolution helpers.
3. Persist a creator-facing preset identifier such as `unifiedConfig.metadata.skillPresetId` so create/edit flows do not rely on skill-array inference when two presets share `['trading']`.
4. Return that identifier in agent API responses and prefer it over skill-array inference in the edit UI.
5. Set the preset’s default `authorizationMode` to `approval_required` on create.

**Why:** this gives creators an obvious UI-level way to opt into advisory, approval-gated trading without adding a new capability family.

### Change 3 — Surface `authorizationMode` in API responses and payloads

**Files:**
- [apps/api/src/routes/agents.ts](../../../../../apps/api/src/routes/agents.ts)
- [apps/api/src/routes/agent-interactivity.ts](../../../../../apps/api/src/routes/agent-interactivity.ts)
- [apps/web/src/features/agents/agent-payloads.ts](../../../../../apps/web/src/features/agents/agent-payloads.ts)
- [apps/web/src/features/agents/agent-form-state.ts](../../../../../apps/web/src/features/agents/agent-form-state.ts)
- API client types in [apps/web/src/lib/api-client.ts](../../../../../apps/web/src/lib/api-client.ts)

**What:**

1. Accept `authorizationMode` on create/update agent routes.
2. Persist it inside `unifiedConfig`.
3. Extend `enrichAgentResponse()` to include it in GET responses, alongside the persisted preset identifier from Change 2.
4. Extend form-state hydration and payload builders so UI create/edit flows round-trip both fields correctly.

**Why:** the creator, the frontend, and the runtime all need the same durable field.

---

## Worker And Runtime Changes

### Change 4 — Make the runtime aware of `authorizationMode`

**Files:**
- [apps/worker/src/agent.ts](../../../../../apps/worker/src/agent.ts)
- [apps/worker/src/runtime-composition.ts](../../../../../apps/worker/src/runtime-composition.ts)
- [apps/worker/src/tools/trading.ts](../../../../../apps/worker/src/tools/trading.ts)
- [packages/domain/src/tools.ts](../../../../../packages/domain/src/tools.ts)

**What:**

1. Include `authorizationMode` in the worker’s resolved agent config.
2. Add an explicit runtime context block or descriptor field so the agent can read it structurally, not just infer it from prose.
3. Update `submit_decision` tool description and prompt guidance to say:
   - in `direct` mode, accepted decisions proceed to execution as today
   - in `approval_required` mode, the decision is recorded and sent to the user for approval; no trade executes until approval
4. Update tool-catalog copy so UI/discovery surfaces present the same semantics.
5. Ensure the runtime context wording prefers `/yes <code>` and `/no <code>` as the recommended user response path.

**Why:** the agent must know the exact contract it is operating under.

### Change 5 — Extend the synchronous `submit_decision` result contract

**Files:**
- [apps/worker/src/tools/trading.ts](../../../../../apps/worker/src/tools/trading.ts)
- [apps/worker/src/agents/agent-decision-handler.ts](../../../../../apps/worker/src/agents/agent-decision-handler.ts)
- any shared protocol typing that models the synchronous reply payload

**What:**

Add a fourth reply status in the decision-submit path:

```ts
type DecisionReply =
  | { status: 'accepted'; planId?: string; message?: string }
  | { status: 'rejected'; code?: string; message?: string }
  | { status: 'error'; code?: string; message?: string }
  | { status: 'pending_approval'; approvalId: string; shortCode: string; expiresAt: string; message?: string };
```

Then update `submit_decision` so the returned tool result is explicit:

```json
{
  "ok": true,
  "status": "pending_approval",
  "approvalId": "...",
  "shortCode": "26B8D",
  "expiresAt": "2026-08-01T12:00:00.000Z",
  "note": "Decision recorded and sent to the user for approval. No trade has been executed yet. Ask the user to approve with /yes 26B8D or reject with /no 26B8D."
}
```

**Why:** the tool contract itself must convey approval semantics clearly; the agent should not need to infer them from prompt text alone.

### Change 6 — Gate decision execution in the decision handler

**Files:**
- [apps/worker/src/agents/agent-decision-handler.ts](../../../../../apps/worker/src/agents/agent-decision-handler.ts)
- new approval repository/service under worker or db package

**What:**

1. Resolve the agent’s current `authorizationMode` before direct execution.
2. If `direct`, keep the existing path.
3. If `approval_required`:
   - resolve enough execution context to build a valid proposal snapshot
   - create a `decision_approvals` row
   - send a synchronous reply with `pending_approval`
   - emit a new activity/event such as `instance.decision.pending_approval`
   - trigger a user-facing platform notification
   - do **not** insert into `decisions` yet
4. Add the new event as an instance/activity event only; do **not** add a new wake source.

**Why:** approval-gating belongs at the execution handoff boundary, not in the agent prompt or UI alone.

---

## Approval Resolution Flow

### Change 7 — Add a dedicated approval service

**Files:**
- new worker/api service and repository slices
- likely wiring in [apps/api/src/routes/agent-interactivity.ts](../../../../../apps/api/src/routes/agent-interactivity.ts)
- possibly shared execution helper extracted from [apps/worker/src/agents/agent-decision-handler.ts](../../../../../apps/worker/src/agents/agent-decision-handler.ts)

**What:**

Create a service responsible for:

1. Looking up pending approvals by code or by “only unresolved approval for this user”.
2. Validating ownership and expiry.
3. Marking approvals approved/rejected/expired.
4. On approval, executing the stored proposal through the normal risk/execution path using current valid trading context.
5. Capturing the resulting `decisionId`, `planId`, and execution outcome back onto the approval record.
6. Recording failed approval-attempt errors without consuming the approval when executable context is unavailable.

Important implementation note:

- Approval execution should not re-enter the agent inbound stream as a stale `agent.decision.submit` message.
- The original runtime session gate in `handleDecisionSubmit()` is appropriate for live agent-originated submissions, but not for delayed human approval of a platform-owned approval object.
- Extract the shared “submit proposal to engine” logic into a reusable service/helper so both paths can use the same risk and execution semantics without depending on the original container session.
- Follow the same context-resolution semantics as today: running actor first; active-grant fallback only for `paper` mode. If `shadow` or `live` approval execution has no running actor, return a recoverable error and keep the approval pending.
- Code-based lookup order is: `(userId, shortCode)` first, then verify unresolved/pending state. Never resolve by `shortCode` alone.

**Why:** approval is a platform-owned state transition that may happen long after the originating agent tick.

### Change 8 — Add web/API endpoints for approvals

**Files:**
- [apps/api/src/routes/agents.ts](../../../../../apps/api/src/routes/agents.ts) or a dedicated approvals route module
- API client types in [apps/web/src/lib/api-client.ts](../../../../../apps/web/src/lib/api-client.ts)

**Minimum v1 endpoints:**

1. `GET /agents/:id/approvals?status=pending`
2. `POST /agents/:id/approvals/:approvalId/approve`
3. `POST /agents/:id/approvals/:approvalId/reject`

Optional helper endpoint if it simplifies Telegram routing:

4. `POST /approvals/resolve-command`

   Payload shape:

```ts
{ action: 'approve' | 'reject', code?: string, source: 'telegram_yes' | 'telegram_no' }
```

**Why:** the web UI needs direct button actions, and the Telegram route needs a single authoritative resolution path.

**Behavioral rule:**

- Web approval buttons act by canonical `approvalId` and do not need the short code.
- Telegram slash commands resolve by `(bound user, short code)` or by the single-pending-approval fallback.
- Both surfaces must hit the same approval-resolution service and enforce the same ownership, expiry, and context-availability checks.

---

## Telegram Slash Commands

### Change 9 — Add `/yes` and `/no` commands

**Files:**
- [apps/api/src/routes/telegram-slash-commands.ts](../../../../../apps/api/src/routes/telegram-slash-commands.ts)
- [apps/api/src/routes/telegram-slash-commands.test.ts](../../../../../apps/api/src/routes/telegram-slash-commands.test.ts)
- [apps/api/src/routes/agent-interactivity.ts](../../../../../apps/api/src/routes/agent-interactivity.ts)
- command help tests and Telegram functional tests

**What:**

1. Extend `SLASH_COMMANDS` with `yes` and `no`.
2. Add help entries and detailed help text.
3. In `processWebhookUpdate()`, route `/yes` and `/no` before the generic “coming soon” fallback.
4. Apply per-user resolution rate limiting using the new operator config.

Command semantics:

- `/yes <code>`: approve the pending approval matching `(bound user, short code)`
- `/no <code>`: reject the pending approval matching `(bound user, short code)`
- `/yes`: allowed only when the user has exactly one unresolved approval
- `/no`: allowed only when the user has exactly one unresolved approval

If there are zero or multiple unresolved approvals and no code is supplied:

- do not guess
- return a friendly response listing the preferred syntax
- explicitly instruct the user to use `/yes <code>` or `/no <code>`
- if there is exactly one unresolved approval, resolve it but still keep all help text and examples codeful-first

Example ambiguous response:

```text
You have 3 pending trade approvals. Please use the code shown in the approval message.

Approve: /yes 26B8D
Reject: /no 26B8D
```

**Why:** explicit platform slash commands give users a fast path while keeping execution authorization unambiguous.

**Error-handling rules:**

- Invalid, foreign, expired, or already-resolved codes should return safe, user-friendly responses without leaking whether a code belongs to another user.
- If approval fails because the agent lacks executable context, tell the user what to fix and keep the approval pending.
- Because codes are user-scoped, the same short code may exist for a different user and must never be treated as a conflict or leak.

### Change 10 — Prefer codeful commands in all approval chat copy

**Files:**
- platform-authored approval notification templates
- [apps/api/src/routes/telegram-slash-commands.ts](../../../../../apps/api/src/routes/telegram-slash-commands.ts)
- public/help docs under [apps/web/src/features/public-pages/content/en](../../../../../apps/web/src/features/public-pages/content/en)
- any in-app instructional copy
- agent-facing runtime prompt copy for approval-required mode

**What:**

All approval-related copy should lead with codeful syntax.

Preferred wording example:

```text
Approve with /yes 26B8D
Reject with /no 26B8D

Tip: /yes or /no without a code only works when you have exactly one pending approval.
```

Do not make code-less commands the hero path in help or examples.

**Why:** codeful commands scale to multiple pending approvals and are the least ambiguous UX.

---

## User-Facing Approval Notification

### Change 11 — Platform-authored approval request message

**Channel:** web UI and Telegram

**Required contents:**

- agent name
- short code
- symbol/instrument
- intent
- target size
- limit price if present
- stop-loss / take-profit if present
- rationale summary
- confidence if present
- expiry time
- explicit command examples:
  - `/yes <code>`
  - `/no <code>`

Suggested Telegram message:

```text
Trade approval requested by Momentum Assistant

Code: 26B8D
Instrument: BTC
Intent: go_long
Target size: 0.05
Limit price: market
Stop loss: 112300
Take profit: 118900
Confidence: 0.74

Rationale:
Breakout above prior range high with rising volume and favorable funding.

Approve with /yes 26B8D
Reject with /no 26B8D

Tip: /yes or /no without a code only works when you have exactly one pending approval.
Expires: 2026-08-01 12:00 UTC
```

Notes:

- This message should be platform-authored, not dependent on the agent calling `send_message`.
- The agent may still send optional narrative follow-up, but the authoritative approval request must come from the platform.
- If Telegram delivery is unavailable, the approval still exists and must remain actionable in the web UI.

---

## Web UI Changes

### Change 12 — Show `authorizationMode` in create/edit/detail views

**Files:**
- [apps/web/src/features/agents/AgentFormBody.tsx](../../../../../apps/web/src/features/agents/AgentFormBody.tsx)
- [apps/web/src/features/agents/AgentsPage.tsx](../../../../../apps/web/src/features/agents/AgentsPage.tsx)
- [apps/web/src/features/agents/AgentDetailPage.tsx](../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
- [apps/web/src/features/agents/AgentSummaryCard.tsx](../../../../../apps/web/src/features/agents/AgentSummaryCard.tsx)

**What:**

1. Add an `authorizationMode` control to create/edit forms.
2. If preset = `trading-assistant`, default the control to `approval_required`.
3. Show current authorization mode on detail/summary pages for trading-capable agents.
4. Make the value clear and non-jargony in UI copy:
   - `Direct` — executes accepted trade decisions immediately
   - `Approval required` — sends each trade decision to you for approval first
5. Show the creator-facing preset name from the persisted preset identifier rather than reverse-inferencing from skill IDs.

**Why:** creators and operators need to see the execution-authorization contract at a glance.

### Change 13 — Add a pending approvals UI

**Files:**
- agent detail page or a dedicated approvals component under [apps/web/src/features/agents](../../../../../apps/web/src/features/agents)

**What:**

1. Show unresolved approvals for an agent.
2. Each card/row includes the short code and full proposal summary.
3. Buttons: `Approve`, `Reject`.
4. Surface execution outcome after resolution.

**Why:** the web UI should be the simplest approval path; Telegram is additive, not exclusive.

---

## Agent Prompt And Context Changes

### Change 14 — Make the approval semantics explicit in runtime composition

**Files:**
- [apps/worker/src/runtime-composition.ts](../../../../../apps/worker/src/runtime-composition.ts)
- trading prompt composition in [apps/worker/src/agent.ts](../../../../../apps/worker/src/agent.ts)

**What:**

Add a small context block similar to other runtime policy blocks:

```text
Authorization Mode
approval_required

Your trade proposals do not execute immediately. When you call submit_decision, the platform records the proposal and asks the user to approve or reject it. No market action occurs until the user approves.
```

For `direct`, the block can say the current behavior plainly.

**Why:** the agent should see this as part of its structured runtime contract.

---

## Documentation Changes

### Change 15 — Update help and public docs

**Files:**
- Telegram help text in [apps/api/src/routes/telegram-slash-commands.ts](../../../../../apps/api/src/routes/telegram-slash-commands.ts)
- public docs/help pages under [apps/web/src/features/public-pages/content/en](../../../../../apps/web/src/features/public-pages/content/en)
- any agent setup documentation that explains skill presets

**What:**

1. Document `trading-assistant` as “trading analysis with per-trade user approval.”
2. Explain `authorizationMode` in agent setup and agent details.
3. Document the slash command workflow using codeful syntax first:
   - `/yes <code>`
   - `/no <code>`
4. Mention that `/yes` and `/no` without a code only work when the user has exactly one unresolved approval.

**Why:** the user explicitly wants codeful approval commands to be the preferred/encouraged path.

---

## Testing Plan

### Domain / Schema

- `UnifiedAgentConfigSchema` accepts and defaults `authorizationMode`
- `trading-assistant` preset resolves to `['trading']`

### API

- create/update agent routes persist and return `authorizationMode`
- agent responses include `authorizationMode`
- pending approval list/approve/reject routes enforce ownership
- code-based approval lookup is scoped by `userId`
- approving an expired approval fails cleanly
- code-less approve/reject is rejected when 0 or >1 pending approvals exist

### Worker / Tooling

- `submit_decision` in `direct` mode keeps existing behavior
- `submit_decision` in `approval_required` mode returns `pending_approval`
- agent decision handler writes approval rows instead of executing directly in approval mode
- approval execution later reuses the engine/risk path correctly
- approval resolution does not depend on the original runtime session ID
- `shadow` and `live` approvals fail closed when no running actor exists; `paper` mode may use the active-grant fallback
- approval-created/resolved events do not create a new wake source

### Telegram

- parser accepts `/yes`, `/yes CODE`, `/no`, `/no CODE`
- help text includes the new commands
- slash routing invokes approval resolution
- ambiguous code-less commands return a friendly instruction preferring `/yes <code>` or `/no <code>`
- slash approval attempts are rate-limited
- identical short codes across different users do not conflict

### Web

- form state hydrates and persists `authorizationMode`
- preset selection round-trips `trading-assistant` correctly via persisted preset identity, not skill-array inference
- pending approval cards render correctly
- detail and summary surfaces show authorization mode

---

## Implementation Order

1. **Schema and config**
   - add `authorizationMode` to unified config
   - add operator approval TTL config

2. **Preset and UI plumbing**
   - add `trading-assistant` preset
   - wire create/edit/detail UI and API payloads

3. **Persistence**
   - add `decision_approvals` schema + migration + repository

4. **Worker path**
   - gate `submit_decision` on `authorizationMode`
   - add `pending_approval` synchronous reply
   - emit approval notification

5. **Resolution service**
   - approve/reject APIs
   - engine handoff from approved proposals

6. **Telegram slash commands**
   - add `/yes` and `/no`
   - add code-less ambiguity handling

7. **Web approvals UI**
   - list approvals
   - buttons and status updates

8. **Docs and copy polish**
   - make `/yes <code>` and `/no <code>` the preferred language everywhere

---

## Exit Criteria

This feature is complete when all of the following are true:

1. A creator can create an agent with preset `trading-assistant`.
2. That preset has the trading skill but not bot-management.
3. The agent’s stored config includes `authorizationMode` and the UI shows it.
4. In `approval_required` mode, `submit_decision` returns a `pending_approval` result with a short human-safe code and no market execution occurs immediately.
5. The user receives a platform-authored approval request containing `/yes <code>` and `/no <code>` examples.
6. The web UI can approve/reject the request.
7. Telegram can approve/reject the request with `/yes <code>` and `/no <code>`.
8. Code-less `/yes` and `/no` only work when the user has exactly one unresolved approval.
9. Approving a request executes through the standard risk/execution path using current valid trading context.
10. If executable context is unavailable at approval time, the platform returns a recoverable error, keeps the approval pending, and does not consume the user’s approval intent.
11. The agent can tell, from prompt/context/tool results, whether it is running in `direct` or `approval_required` mode.

---

## Outstanding Issues (post-implementation)

Recorded after completing the implementation (10 commits, 2026-07-31). Items are classified by severity.

### Already Fixed in Implementation

- ✅ `EditAgentModal` preset change now updates `authorizationMode` (trading-assistant → approval_required, others → direct), matching create flow behavior.
- ✅ `EditAgentModal` preset change now clears `authorizationMode` consistently for non-trading presets.
- ✅ **HIGH Gap 1 (fixed):** Platform-authored Telegram notifications delivered via `sendApprovalTelegramNotification` in `AgentDecisionHandler`.
- ✅ **HIGH Gap 2 (fixed):** Approval `pending → approved` transition moved into worker's `ApprovalService.executeApproval()` after execution context validation.
- ✅ API returns 503 (not 200) when Redis unavailable in web approve endpoint.
- ✅ `recordResolutionAttempt` added on Redis publish failure in both web and Telegram handlers.

### Still Outstanding

#### MEDIUM

- **M1 — `countPendingByUserId` uses full-row SELECT instead of `COUNT()`:** Fetches all 31 columns for every pending row just to count. Fix with Drizzle `count()` aggregation if performance becomes an issue for users with many pending approvals.
- **M2 — Missing tests for approval workflow:** No unit tests for `submit_decision` in approval mode, `AgentDecisionHandler` approval gating, `ApprovalService.executeApproval()`/`rejectApproval()`, API approval endpoints, or end-to-end approval → execution integration tests.
- **M3 — Expired approvals counted as pending in code-less path:** `countPendingByUserId` filters by `status = 'pending'` but not `expiresAt > NOW()`. An expired-but-not-yet-swept approval inflates the pending count. Add `AND expiresAt > NOW()` filter.

#### LOW

- **L1 — Schema and config:** `resolveAuthorizationMode()` helper was dead code until Change 3 wired it in. No longer applicable post-implementation.
- **L2 — Persistence:** `status` field typed as `string` in `InsertDecisionApproval` rather than union type — matches existing codebase convention.
- **L3 — Persistence:** `countPendingByUserId` and `findPendingByUserId` share identical WHERE logic — acceptable per DRY rule (only 2 occurrences).
- **L4 — Persistence:** `actorType` default of `'agent'` is redundant since repository always sets it explicitly — harmless defensive design.
- **L5 — Worker path:** `confidence` stored as string in DB column but raw number in `proposedPayload`. Functionally correct since both serve different purposes (display vs execution replay).
- **L6 — Worker path:** `submit_decision` tool handler doesn't read `ctx.authorizationMode` — relies entirely on reply status from handler. Could provide an upfront mode-awareness message.
- **L7 — No subscription cleanup on Redis subscriber restart:** Worker subscribes to `approval:execute:*` via `psubscribe`. If process exits abruptly (SIGKILL, OOM), subscription cleanup doesn't run. Redis auto-drops subscriptions on disconnect — minor concern.
- **L8 — Dry-run blocked in approval mode:** `submit_decision` with `dryRun: true` is rejected in `approval_required` mode. Tool `promptGuidance` says "Use dryRun=true first to preview" which is misleading. Either allow dry-run or update guidance.
- **L9 — `publishUserNotification` lacks retry/delivery guarantee:** Fire-and-forget with try/catch logging. Acceptable for v1 but no acknowledgment or retry mechanism.
- **L10 — i18n formatting:** Web UI shows Telegram hint as inline `Or from Telegram: /yes {code} or /no {code}` rather than each command on its own line as preferred in the plan.
