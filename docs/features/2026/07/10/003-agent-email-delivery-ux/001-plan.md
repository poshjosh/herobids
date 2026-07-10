# Agent Email Delivery UX

**Status:** draft
**Created:** 2026-07-10
**Related:** [Marketplace Discovery — Vision & Current State](../060-agent-blueprint-marketplace/000-vision-and-current-state.md)

## Goal

Make agent-authored email delivery feel predictable and usable:

1. a user can tell an agent to send an email and it sends without hidden policy traps
2. users can control that behavior from both account settings and the agent create/edit form
3. `messageClass` remains useful, but only as presentation metadata, not as a silent delivery gate

## Current Baseline

Today the system behaves like this:

1. `send_message` supports `messageClass` and `emailDelivery` in [apps/worker/src/tools/messaging.ts](../../../../apps/worker/src/tools/messaging.ts).
2. The broker in [apps/worker/src/agents/agent-message-broker.ts](../../../../apps/worker/src/agents/agent-message-broker.ts) only emails when all of these are true:
   - `emailDelivery === "if_allowed"`
   - `messageClass` is `alert` or `reminder`
   - operator email infrastructure exists
   - `agent.notificationPolicy.sendMessage.email.enabled === true`
   - the owning user has an account email
3. Agent-level `notificationPolicy` exists in the API contract in [apps/api/src/routes/agents.ts](../../../../apps/api/src/routes/agents.ts), but there is no web UI for it.
4. User settings in [apps/api/src/routes/auth.ts](../../../../apps/api/src/routes/auth.ts) and [apps/web/src/features/settings/SettingsPage.tsx](../../../../apps/web/src/features/settings/SettingsPage.tsx) currently support locale and Telegram, but no email-delivery preference.
5. The web already receives `messageClass` and email delivery status for outbound messages, but the UI in [apps/web/src/features/agents/AgentDetailPage.tsx](../../../../apps/web/src/features/agents/AgentDetailPage.tsx) does not use `messageClass` as a first-class presentation signal.

The result is bad UX: a user can explicitly ask for email, yet the system silently suppresses it because of an internal class label or an invisible agent policy.

## Desired UX Contract

After this feature:

1. Every user has an account-level default for agent email delivery in Settings.
2. Every agent has a per-agent override in the create/edit form.
3. If an agent calls `send_message` with `emailDelivery: "if_allowed"`, email sends unless delivery is explicitly disabled or technically impossible.
4. `messageClass` influences presentation only:
   - badges
   - labels
   - optional message-list prioritization/filtering
   - fallback email subject copy
5. Email is always sent to the owning user's account email in this slice. The agent does not choose arbitrary recipients.
6. If email is skipped or fails, the user can see why in the UI.

## Product Decisions Encoded By This Plan

1. **Account default + agent override.** Email preference exists at two layers:
   - user settings = default behavior for all agents
   - agent form = per-agent override
2. **Agent policy is tri-state in the UI.** The form exposes:
   - inherit account default
   - always allow email when requested
   - never allow email
3. **Agent-level storage remains nullable.** `agents.notificationPolicy = null` means inherit. Existing explicit agent policies remain valid.
4. **System default is enabled.** If neither the user nor the agent has set a preference yet, the effective default is email allowed. This is intentional because the goal is “tell an agent to email me and it just works.”
5. **`emailDelivery` is the delivery-intent flag.** `messageClass` must not override an explicit email request.
6. **`messageClass` stays meaningful.** It continues to describe urgency/type for UI and fallback copy, but not whether delivery is allowed.
7. **Delivery transparency is required.** A skipped email must not look identical to a successful send.

## Scope

In scope:

1. user-level email delivery preference storage and API support
2. agent-level override UI and payload plumbing
3. worker-side effective policy resolution
4. removal of `messageClass` as an email eligibility gate
5. message presentation updates in the agent detail experience
6. tests for API, worker policy resolution, and web UI state

Out of scope:

1. arbitrary recipient addresses in `send_message`
2. multiple recipients, CC, or BCC
3. HTML email templating redesign
4. a general notification-center overhaul beyond this message flow
5. blueprint copying changes, except to stay compatible with the blueprint direction already documented

## Design

### 1. Effective policy resolution

Resolve send-message email permission in this order:

1. agent-level explicit override
2. user-level explicit default
3. system default (`enabled = true`)

This mirrors the existing Telegram destination precedence pattern, where agent-level configuration can override user-level defaults.

### 2. Data model

#### User-level default

Add a new nullable JSONB field on `users`, for example:

```ts
notificationPreferences: {
  sendMessage?: {
    email?: {
      enabled: boolean;
      source: 'explicit_update';
      enabledAt?: string;
    };
  };
} | null
```

Notes:

1. Keep the shape intentionally parallel to `agents.notificationPolicy` to minimize translation logic.
2. `null` means “no explicit user preference saved yet,” which falls through to the system default.
3. This is user-owned account configuration, so it belongs on `users`, not in `unifiedConfig`.

#### Agent-level override

Keep using `agents.notificationPolicy`.

Semantics after this feature:

1. `null` = inherit user default
2. explicit `enabled: true` = allow email for this agent
3. explicit `enabled: false` = disable email for this agent

No agent schema redesign is required for this slice.

### 3. Web UX

#### Settings page

Add an “Agent Email Delivery” card to [apps/web/src/features/settings/SettingsPage.tsx](../../../../apps/web/src/features/settings/SettingsPage.tsx):

1. toggle: `Allow my agents to email me when they explicitly request email`
2. helper copy: emails go to the account email already on file
3. note that individual agents can override this in their own settings

This is the global default.

#### Agent create/edit form

Add a per-agent email delivery control to the create/edit agent experience in [apps/web/src/features/agents/AgentFormBody.tsx](../../../../apps/web/src/features/agents/AgentFormBody.tsx).

Recommended control shape:

1. `Use account default`
2. `Allow email for this agent`
3. `Do not allow email for this agent`

Recommended placement:

1. in the same broad notifications/communications area as Telegram, not buried inside unrelated trading controls
2. visible enough that the feature is discoverable during both create and edit flows

The form should also show the destination email address read-only for clarity.

### 4. Broker behavior

Update [apps/worker/src/agents/agent-message-broker.ts](../../../../apps/worker/src/agents/agent-message-broker.ts) so that:

1. `payload.emailDelivery !== "if_allowed"` still means feed-only
2. `messageClass` no longer blocks email
3. effective email enablement is resolved from agent override → user default → system default
4. missing operator email infrastructure still records `email_skipped_not_configured`
5. missing account email still records `email_skipped_no_verified_recipient`
6. policy-disabled email still records `email_skipped_policy`

Fallback email subjects should continue to use `messageClass`, but routine messages need a neutral subject, for example `Message from your agent`.

### 5. Presentation behavior

Use `messageClass` in the UI rather than in delivery gating.

Initial presentation changes:

1. show a badge or label for `routine`, `alert`, and `reminder`
2. include delivery detail when email was sent, skipped, or failed
3. keep the primary timeline chronological
4. if a dedicated message list gets prioritization later, let it prefer `alert`/`reminder` visually without changing delivery semantics

This keeps `messageClass` useful while removing the hidden coupling to transport.

## Implementation Plan

### Slice 1 — User preference storage and profile API [DONE]

Goal: add a user-level default for send-message email delivery.

Tasks:

1. add `users.notificationPreferences` to the DB schema
2. add migration for the new column
3. extend `GET /auth/me` to return `notificationPreferences`
4. extend `PATCH /auth/me` to accept and validate `notificationPreferences`
5. add a helper similar to `resolveNotificationPolicy` for user-level normalization and `enabledAt` handling
6. extend web API client types for the profile payload

Expected result:

The platform has a persistent account-level default for agent email delivery.

### Slice 2 — Agent form override plumbing [DONE]

Goal: expose per-agent email delivery control in create/edit agent flows.

Tasks:

1. extend web `AgentFormState` to represent the tri-state selection
2. hydrate that field from the API agent payload in `agentToFormState`
3. include it in create/update payload builders in [apps/web/src/features/agents/agent-payloads.ts](../../../../apps/web/src/features/agents/agent-payloads.ts)
4. keep `null` as inherit when the user selects account default
5. add localized labels/help text
6. add create/edit flow tests that verify:
   - inherit sends `notificationPolicy: null` or omission as intended
   - explicit allow persists `enabled: true`
   - explicit disable persists `enabled: false`

Expected result:

Users can discover and configure agent email behavior directly from the agent UI.

### Slice 3 — Settings page UI [PENDING]

Goal: expose the global default in user settings.

Tasks:

1. add a new card to [apps/web/src/features/settings/SettingsPage.tsx](../../../../apps/web/src/features/settings/SettingsPage.tsx)
2. load the saved setting from `meQuery`
3. persist changes through `authApi.updateMe(...)`
4. show the account email address as the delivery destination
5. add save success and error handling matching the existing settings cards
6. add tests for save-button enable/disable behavior and request payloads

Expected result:

The user has one obvious account-level place to say whether their agents may email them by default.

### Slice 4 — Worker resolution and delivery semantics [PENDING]

Goal: make explicit email requests send unless explicitly disabled or technically blocked.

Tasks:

1. add repository support for resolving the effective email policy from agent + user rows
2. remove the `routine` message-class gate from email fanout
3. retain `emailDelivery` as the explicit per-message opt-in
4. keep existing infra, recipient, and rate-limit checks
5. update broker tests in [apps/worker/src/agents/agent-broker-email.test.ts](../../../../apps/worker/src/agents/agent-broker-email.test.ts) to cover:
   - routine messages now emailing successfully
   - agent explicit disable overriding user enable
   - agent explicit enable overriding user disable
   - inherited user enable
   - inherited system default enable when both layers are unset
6. update any runtime prompt guidance that tells the model to choose `alert` solely to make email work

Expected result:

The worker enforces the intended precedence model, and `messageClass` no longer acts as a hidden veto.

### Slice 5 — In-app delivery feedback and message presentation [PENDING]

Goal: make delivery outcomes and message class visible to the user.

Tasks:

1. add `messageClass` badges in the agent message UI
2. add readable copy for email delivery states:
   - sent
   - skipped by policy
   - skipped because email infrastructure is not configured
   - skipped because no verified recipient exists
   - failed at provider
3. surface that detail in the message list and, where appropriate, the activity timeline mapping
4. add web tests for the new rendering states

Expected result:

If a user asks “did my agent email me?”, the UI answers clearly.

## Validation Plan

### Automated

1. API route tests for `GET /auth/me` and `PATCH /auth/me` notification preferences
2. agent route tests for create/update agent notification policy behavior
3. worker tests for effective policy resolution and routine-message delivery
4. web tests for settings save behavior and agent form payload generation
5. web tests for message badge and delivery-detail rendering

### Manual

1. enable account-level email default in Settings, leave agent on inherit, trigger `send_message` with `messageClass: "routine"` and `emailDelivery: "if_allowed"`, confirm email sends
2. disable account-level default, leave agent on inherit, trigger the same message, confirm email is skipped and UI explains why
3. disable account-level default, explicitly enable a single agent, confirm that agent emails while others do not
4. enable account default, explicitly disable one agent, confirm that agent does not email
5. verify `alert`, `reminder`, and `routine` render different badges but use the same delivery rules

## Risks and Mitigations

1. **Behavioral change for existing agents with `notificationPolicy = null`.** They will become email-capable when they explicitly request email. This is intentional, but should be called out in release notes.
2. **Policy drift between user and agent layers.** Mitigate by centralizing effective-resolution logic in one repository/helper path instead of duplicating it in UI and worker code.
3. **User confusion about where email goes.** Mitigate by showing the destination account email in Settings and in the agent form help text.
4. **Silent failures from infra misconfiguration.** Mitigate by surfacing skipped/not-configured states in the UI.

## Non-Blocking Assumption

This plan assumes the product direction is to default send-message email delivery to enabled when no explicit preference exists yet.

If that assumption changes, the implementation still works, but Slice 1 and Slice 4 would need a different system default and a more cautious rollout plan.