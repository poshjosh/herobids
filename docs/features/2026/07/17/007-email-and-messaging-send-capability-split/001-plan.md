# Email And Messaging Send Capability Split

**Status:** implemented
**Created:** 2026-07-17
**Depends on:**
- [003-gmail-oauth-connection](../003-gmail-oauth-connection/001-plan.md)
- [006-more-tools/001-send-message-email-policy](../../06/10/006-more-tools/001-send-message-email-policy.md)
- [006-more-tools/002-plan](../../06/10/006-more-tools/002-plan.md)

## Summary

Keep email and messaging as separate agent capabilities and separate tool families, with this feature scoped to sending only.

Target end state for this feature:

- outbound email tools:
   - `send_email`
- outbound and inbox-style messaging tools:
   - `send_message`
- capability and skill shape:
   - `email` is a distinct capability family and skill
   - messaging remains part of the base skill; there is no separate messaging skill
- providers remain implementation details:
   - Gmail backs the `email` capability in this slice
   - Telegram and platform inbox delivery back the `messaging` capability in this slice

Backward compatibility is **not** required. This plan targets the clean end state directly and focuses on the send surfaces only.

## Problem

The current system mixes capability shape, tool shape, and provider shape in ways that make outbound communication harder to reason about than it needs to be.

Current issues:

1. `send_email` and `send_message` already point toward two distinct capability families, but the surrounding guidance is not cleanly aligned.
2. The current system skill is named `gmail`, which is provider-shaped rather than capability-shaped.
3. The brokered `send_message` behavior currently overlaps with email fanout behavior, which blurs the boundary between email and messaging.
4. The current plan and naming do not cleanly express that email delivery should happen through `send_email`, not through secondary `send_message` fanout behavior.

The right abstraction is not “one tool to rule them all.” The right abstraction is:

- tools reflect distinct user intents and data models
- skills reflect capability families
- providers stay behind the runtime boundary

## Goals

1. Keep email and messaging separate at the tool level.
2. Rename provider-shaped skill language to capability-shaped language.
3. Preserve a clean provider boundary so Gmail remains an implementation detail, not the user-facing capability name.
4. Make the runtime prompt explicit enough that agents can choose the correct email connection when needed.
5. Remove stale guidance that treats `send_message` email fanout as part of the email API.
6. Ensure all email delivery flows through `send_email`.

## Non-Goals

1. Backward compatibility for old tool names, old payloads, or old skill naming.
2. Implementing `read_emails` in this feature.
3. Implementing `read_messages` in this feature.
4. Supporting additional email providers beyond Gmail in this slice.
5. Supporting additional messaging providers beyond the current Telegram and platform messaging paths in this slice.

## Fixed Decisions

These are settled decisions for this plan.

1. Email and messaging remain separate tool families.
2. The public email tool in this feature is `send_email`.
3. The public messaging tool in this feature is `send_message`.
4. The skill id and name both change to `email`; `gmail` is not retained internally.
5. There is no separate messaging skill; messaging remains part of the base skill.
6. Gmail remains the provider behind the `email` capability in this slice.
7. `send_message` is for messaging semantics only.
8. All email delivery moves to `send_email`.
9. `send_email` should expose optional `fromConnectionId` from day one.
10. The agent prompt must surface granted email connections clearly enough for `fromConnectionId` to be usable.
11. Do not require confirmation flows for external email sending.
12. Backward compatibility is not required.

## Target Capability Model

### Email capability

Skill name:

- `Email`

Provider in this slice:

- Gmail

Public tool:

- `send_email`

Core semantics:

- arbitrary external recipients
- subject lines
- cc / bcc
- explicit sender connection selection where needed

### Messaging capability

Skill surface:

- No separate messaging skill
- `send_message` remains part of the base skill

Providers in this slice:

- Telegram
- platform inbox / user feed

Public tool:

- `send_message`

Core semantics:

- communicate with the owning user
- preserve brokered delivery, routing, and audit behavior

## Proposed Tool Contracts

### `send_email`

```ts
type SendEmailParams = {
   to: string | string[];
   subject: string;
   body: string;
   cc?: string | string[];
   bcc?: string | string[];
   fromConnectionId?: string;
};
```

Semantics:

1. Sends email through a granted ready email connection.
2. `fromConnectionId` is optional.
3. If `fromConnectionId` is omitted, runtime uses the default ready email connection.
4. If `fromConnectionId` is provided, runtime must validate that the connection belongs to the agent, is active, and is email-capable.

### `send_message`

```ts
type SendMessageParams = {
   body: string;
   subject?: string;
   messageClass?: 'routine' | 'alert' | 'reminder';
   contextRef?: string;
};
```

Semantics:

1. Sends a brokered message to the owning user.
2. Messaging delivery remains provider-routed by the platform.
3. It is not the public API for arbitrary external email recipients.

## Runtime Rules

### Email rules

1. `send_email` requires at least one granted ready email connection.
2. `fromConnectionId` is optional but, when supplied, must resolve to a granted ready email connection.
3. Email delivery uses Gmail in this slice.
4. No confirmation gate is introduced for external recipients.
5. Rate limits and audit logging remain enforced.

### Messaging rules

1. `send_message` is scoped to user-directed messaging.
2. Messaging delivery remains broker-controlled.
3. Messaging should not silently become general-purpose email sending.

### Prompt and visibility rules

1. The agent prompt must list granted email connections explicitly.
2. The prompt must indicate the default email connection.
3. The tool guidance for `send_email` must tell the agent how to use `fromConnectionId`.
4. Provider names may appear in readiness and connection metadata, but the skill/capability name stays `email`.

## Architecture Direction

The architecture should separate capability families while keeping provider specifics behind the runtime boundary.

Current state:

- `send_message` is brokered and may trigger Telegram plus optional email fanout
- `send_email` is a direct Gmail-backed tool
- the skill is named `gmail`

Target state:

- `send_email` is the public email sending tool
- `send_message` is the public messaging tool
- the skill id and name become `email`
- Gmail token resolution and Gmail adapter remain behind the email capability implementation
- user messaging remains brokered and auditable
- email fanout is removed from `send_message`

This keeps the agent-facing surface stable even if providers change later.

## Plan

### 1. Rename the capability-facing skill surface

Files likely affected:

- `packages/domain/src/skills.ts`
- prompt rendering or skill seed surfaces
- tests that reference the `gmail` skill id or name

Changes:

1. Replace the `gmail` skill with an `email` skill.
2. Update descriptions and instructions so they refer to the capability, not the provider.
3. Keep the binding requirement on the `email` capability family.
4. Update any prompt hints and examples to use `send_email`.
5. Remove wording that tells the agent to use `send_message` as an email approval path.

### 2. Redefine the public domain tool catalog

Files likely affected:

- `packages/domain/src/tools.ts`
- `packages/domain/src/agent-protocol.ts`
- `packages/domain/src/tool-schemas.ts`
- exported domain indices

Changes:

1. Keep `send_email` and `send_message` as distinct public tools.
2. Keep the known tool list, catalog, protocol, and schemas aligned around the sending tools in this feature.
3. Define distinct payload schemas for `send_email` and `send_message`.
4. Add `fromConnectionId` to the email tool schema.
5. Keep messaging payloads focused on message semantics rather than email semantics.

### 3. Rework worker tool registration to match the split

Files likely affected:

- `apps/worker/src/tools/email.ts`
- `apps/worker/src/tools/messaging.ts`
- `apps/worker/src/tools/index.ts`

Changes:

1. Keep `send_email` as a public tool.
2. Keep email tool registration focused on sending.
3. Keep `send_message` as a public tool.
4. Keep messaging tool registration focused on messaging.
5. Ensure registry wiring and catalog consistency checks cover both tools.

### 4. Implement explicit email connection selection

Files likely affected:

- `apps/worker/src/gmail-credential-resolver.ts`
- `packages/db/src/agent-runtime-descriptor.ts`
- `apps/worker/src/runtime-composition.ts`
- email tool tests

Changes:

1. Replace the current implicit default-email resolution path with explicit family-default resolution.
2. Allow `send_email` to accept optional `fromConnectionId`.
3. Validate `fromConnectionId` against the agent's granted ready email connections.
4. Surface granted email connections and the default email connection in the runtime prompt.
5. Update tool guidance so the agent knows when to omit or supply `fromConnectionId`.

### 5. Keep email delivery exclusively under `send_email`

Files likely affected:

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/tools/email.ts`
- messaging policy helpers
- relevant docs and tests

Changes:

1. Remove email delivery from `send_message` behavior.
2. Remove or disable secondary email fanout from the brokered messaging path.
3. Keep all external and user-directed email sending behind `send_email`.
4. Update documentation and tests so there is no ambiguity about which tool sends email.

### 6. Simplify `send_message` policy to pure messaging

Files likely affected:

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/worker/src/tools/messaging.ts`
- repository status fields and related tests

Changes:

1. Keep `send_message` scoped to user messaging only.
2. Keep routing, rate limiting, and auditing explicit.
3. Remove any documentation or prompt language that implies `send_message` is the place to compose arbitrary emails.

### 7. Reconcile persistence and audit models

Files likely affected:

- `packages/db/src/schema/agent-outbound-messages.ts`
- `packages/db/src/agent-repository.ts`
- email and messaging repository tests

Changes:

1. Ensure audit records can distinguish email actions from messaging actions.
2. Preserve provider-specific outcome details without leaking provider concepts into the capability name.
3. Ensure persistence no longer assumes message-originated email fanout.

### 8. Rewrite prompt-facing guidance end to end

Files likely affected:

- `packages/domain/src/skills.ts`
- `apps/worker/src/runtime-composition.ts`
- tool descriptions and schema guidance

Changes:

1. Show the agent which tool belongs to `email` and which belongs to `messaging`.
2. Show granted email connections explicitly, including which one is default.
3. Add examples such as:
    - “Email bob@example.com a summary” → `send_email`
    - “Message me an alert” → `send_message`
4. Remove stale provider-first wording from all built-in skills.

### 9. Tests

Files likely affected:

- domain tool tests
- worker tool tests
- broker tests
- runtime visibility and prompt tests
- OAuth and Gmail integration tests

Required coverage:

1. The `email` skill replaces the `gmail` skill, including the skill id.
2. `fromConnectionId` works and rejects invalid or unauthorized connections.
3. Default email connection selection works when `fromConnectionId` is omitted.
4. `send_message` remains user-messaging-scoped.
5. `send_email` remains the exclusive email delivery tool.
6. Email fanout no longer occurs through `send_message`.
7. `pnpm lint` passes and focused tests pass.

### 10. Documentation cleanup

Files likely affected:

- this plan
- Gmail OAuth docs
- old send-message email-policy docs
- any tool audits or prompt guidance docs

Changes:

1. Mark prior unified-tool thinking as superseded.
2. Mark the old `gmail` skill naming as superseded.
3. Document the separate `email` and `messaging` capability model clearly.
4. Update docs to reflect that this plan is scoped to sending.

## Validation

Implementation is complete only when all of the following are true:

1. The skill id and name are `email`, not `gmail`.
2. The public sending tool surface contains:
   - `send_email`
   - `send_message`
3. `send_email` supports optional `fromConnectionId`.
4. The runtime prompt clearly lists granted email connections and the default email connection.
5. `send_message` and `send_email` no longer blur capability boundaries.
6. `send_message` no longer performs email delivery.
7. `pnpm lint` passes.
8. Focused domain, worker, broker, and OAuth tests pass.

## Risks

1. If prompt context is too vague, agents may misuse `fromConnectionId`.
2. Removing email fanout from `send_message` may require cleanup across more broker and UI surfaces than expected.
3. Old documentation may continue to bias implementation toward provider-first naming.

## Open Questions

None.