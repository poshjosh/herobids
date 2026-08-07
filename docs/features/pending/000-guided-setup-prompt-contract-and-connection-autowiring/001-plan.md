# Plan: Guided Setup Prompt Contract And Connection Autowiring

**Feature:** Guided Setup reliability hardening
**Date:** 2026-08-07
**Status:** Draft
**Related:**
- [AI-First UX / Onboarding Chat](../../2026/08/01/005-ai-first-ux/002-onboarding-chat.md)
- [Guided Setup Inline Connection Form](../../2026/08/05/002-guided-setup-inline-connection-form/001-plan.md)
- [Guided Setup Gmail Resume After OAuth](../../2026/08/06/001-guided-setup-gmail-resume-after-oauth/001-plan.md)
- [Guided Setup Skills And Scanner-Gated](../../2026/08/06/007-guided-setup-skills-and-scanner-gated/001-plan.md)
- [Fix Guided Setup Missing Agent Config](../../2026/08/07/001-fix-guided-setup-missing-agent-config/001-plan.md)
- [Progressive Connection Setup](../../2026/08/07/004-progressive-connection-setup/001-plan.md)

## Summary

The Guided Setup chat currently has a prompt/runtime contract gap in `apps/api/src/routes/chat.ts`:

1. the prompt claims compatible connections can be auto-used, but the backend only binds a connection when `selectedConnectionId` is explicitly present
2. the prompt examples for `create_connection` do not match the tool schema
3. the prompt implies mid-thread quick replies exist, but the runtime only emits them in the seeded greeting
4. the prompt encourages proactive docs-tool usage even though the current API-local Guided Setup runtime does not need that path to stay reliable

This gap is not cosmetic. It already caused at least one real failure mode:

- the LLM called `create_connection`
- the tool returned a valid `connectionId`
- the LLM then called `create_agent` without `selectedConnectionId`
- the agent was created without any connection and correctly showed `Trading: Unconfigured`

The high-value fix is to harden the backend so Guided Setup auto-wires compatible connections when omission is safe, then tighten the prompt and tool descriptions so they describe the true runtime behavior.

## Goals

1. Prevent Guided Setup from creating trading agents without a just-created or clearly recommended compatible connection when the omission is resolvable server-side.
2. Make the `create_connection` tool contract match the happy-path prompt.
3. Remove prompt instructions that describe capabilities the runtime does not actually provide after turn one.
4. Remove docs-tool references from the Guided Setup prompt so the current flow stays reliable and self-contained.
5. Preserve the existing out-of-band form switch in the frontend. This plan does not change that control.

## Non-Goals

- Implementing a new mid-thread `quick_replies` action system.
- Wiring the API-local Guided Setup runtime to the real platform-docs index.
- Redesigning the create-agent page tabs, billing gate, or "Use the form" control.
- Reworking the broader create-parity plan already covered in [Fix Guided Setup Missing Agent Config](../../2026/08/07/001-fix-guided-setup-missing-agent-config/001-plan.md).

## Current State

### Prompt / tool-contract mismatches

In `apps/api/src/routes/chat.ts` today:

- the system prompt says a recommended compatible connection can be auto-used
- `selectedConnectionId` is documented as auto-selected when omitted
- `create_connection` examples omit fields that the tool schema currently requires
- the prompt says to use quick replies if Q0 is unanswered, even though post-greeting turns cannot emit quick replies
- the prompt says to use the docs tools before asking users to make choices, even though this API route's docs handlers are placeholder responses

### Connection loss root cause

The same-turn tool loop already has enough information to avoid the observed bug:

- `invokeOnboardingLlm()` sees every tool result in sequence
- `create_connection` returns `connectionId`
- `list_compatible_connections` returns `recommended`

But the subsequent `create_agent` execution path does not consume that conversation-local context. The `create_agent` handler only binds:

```ts
const connectionIds = parsed.data.selectedConnectionId ? [parsed.data.selectedConnectionId] : [];
```

So omission currently means “no connection”, not “best compatible connection”.

## Decision

Adopt a **backend-first reliability fix**:

1. introduce invocation-local connection-resolution context inside the Guided Setup tool loop
2. auto-fill `selectedConnectionId` server-side when omission is safe and deterministic
3. only rely on prompt wording for disambiguation and user-visible explanation, not for correctness

This is better than a prompt-only fix because it closes the exact class of failure that already occurred.

## Workstream 1: Backend Connection Autowiring

### Objective

Make Guided Setup `create_agent` resilient when the model omits `selectedConnectionId` but a compatible connection is already known from:

- a same-turn `create_connection` call
- a same-turn `list_compatible_connections` recommendation
- persisted thread-summary connection state from an earlier connection step

### Design

Introduce a small Guided Setup-local connection-resolution context, owned by the onboarding tool loop.

Suggested shape:

```ts
interface GuidedSetupResolvedConnectionContext {
  createdConnectionIds: string[];
  recommendedConnectionIds: string[];
  threadConnectionIds: string[];
}
```

Resolution precedence:

1. explicit `selectedConnectionId` from the model
2. same-turn `create_connection` result
3. same-turn `list_compatible_connections.recommended`
4. thread metadata `summary.connectionIds`
5. fresh backend lookup when the above are absent and exactly one compatible connection exists

### Rules

#### Trading presets

If `skillPresetId` is trading-capable and `selectedConnectionId` is omitted:

- use the same-turn created connection if one exists
- else use the recommended compatible trading connection if one exists
- else if exactly one compatible active trading connection exists, use it
- else leave the agent unconnected and return an actionable tool error that tells the model to ask the user or pass a specific connection

#### Non-trading presets

If `selectedConnectionId` is omitted:

- auto-assign only when exactly one compatible non-trading connection is resolvable from context or lookup
- if multiple equally valid non-trading connections exist and no context disambiguates them, do not guess; return an actionable tool error so the model asks the user which one to use

### Required changes

#### `apps/api/src/routes/chat.ts`

1. Add invocation-local connection context tracking inside `invokeOnboardingLlm()`.
2. Capture successful `create_connection` results into that context.
3. Continue capturing `list_compatible_connections.recommended` into that context.
4. Thread this context into `executeChatAction()` or a narrower helper used by the `create_agent` branch.
5. Resolve an effective connection ID before agent creation when omission is safe.
6. Validate compatibility before assignment so a trading agent never auto-binds a non-trading connection, and vice versa.
7. Return explicit structured errors for ambiguous omission cases.

### Same-turn bug fix requirement

The following sequence must work with no prompt heroics:

1. `create_connection(provider='jupiter', credentialMode='generated')`
2. tool returns `connectionId='conn-123'`
3. model calls `create_agent(...)` without `selectedConnectionId`
4. backend auto-wires `conn-123`

This is the highest-priority regression to close.

## Workstream 2: Simplify `create_connection`

### Objective

Make the tool schema reflect the real Guided Setup happy path instead of forcing the prompt to emit overly verbose argument payloads.

### Decision

For Guided Setup API-local `create_connection`, make:

- `label` optional
- `capability` optional or inferred server-side

The onboarding path only uses this tool for generated trading connections tied to a known provider. The runtime can derive the rest.

### Proposed contract

Preferred minimal call shape:

```ts
create_connection({ provider: 'jupiter', credentialMode: 'generated' })
```

Server-side behavior:

- infer `capability = 'trading'`
- derive a deterministic default label from the provider
- preserve the current validation that `credentialMode` must be `generated`

Example derived labels:

- `Hyperliquid Wallet`
- `Jupiter Wallet`
- `1inch Wallet`

### Required changes

#### `apps/api/src/routes/chat.ts`

1. Loosen the `CHAT_TOOLS` schema for `create_connection`.
2. Loosen the runtime argument parsing in the `create_connection` branch.
3. Derive missing label and capability server-side.
4. Keep unknown-provider and disabled-wallet-generation errors unchanged.

### Prompt contract update

Even with server-side autowiring in Workstream 1, the tool description should explicitly say the result includes a `connectionId` that is used to assign the agent.

## Workstream 3: Prompt Contract Cleanup

### Objective

Make `buildSystemPrompt()` describe only behaviors the current Guided Setup runtime actually provides.

### Required prompt changes

#### 1. Fix misleading `selectedConnectionId` wording

Replace the current description that implies omission always auto-selects a connection.

New meaning:

- `selectedConnectionId` identifies the connection to assign to the agent
- omission is only safe when the backend can resolve a single compatible connection deterministically
- when the user is choosing among multiple compatible non-trading connections, the model must ask

#### 2. Fix `create_connection` guidance

Add explicit wording that:

- the tool returns a `connectionId`
- the backend can auto-assign a same-turn created connection when `create_agent` follows immediately
- if the model wants a specific existing connection instead of the default resolved one, it should still pass `selectedConnectionId`

#### 3. Remove fake mid-thread quick-reply instructions

The prompt must stop implying that the runtime can emit arbitrary `quick_replies` after the seeded greeting.

Replace with:

- initial preset buttons are UI-provided in the greeting
- all later follow-up choices should be asked in plain language
- if the user answers with free text, continue naturally

#### 4. Remove docs-tool references

Because the current Guided Setup priority is reliability, remove:

- the system-prompt instruction to use docs tools before asking ordinary onboarding questions
- proactive mention of docs tools in the Guided Setup flow

Optional follow-up:

- if no current Guided Setup behavior depends on those tools, remove them from `CHAT_TOOLS` in this API route as well so the LLM cannot spend tool rounds on them

### Files

#### `apps/api/src/routes/chat.ts`

Update:

- `buildSystemPrompt()` body
- `CHAT_TOOLS` descriptions for `create_connection` and `create_agent.selectedConnectionId`

## Workstream 4: API Tool Surface Reduction For Reliability

### Objective

Reduce the API-local Guided Setup surface to the minimal set required for the current working flow.

### Recommended change

In this pass, remove the three docs tools from the API-local Guided Setup runtime:

- `search_app_docs`
- `list_app_docs`
- `read_app_docs`

This is specifically for `apps/api/src/routes/chat.ts`, not for the worker runtime or the broader platform-docs investment.

### Reasoning

- the prompt-local guidance already carries the onboarding rules we need
- the current user request prioritizes reliability over richer docs-assisted behavior
- the current API-local handlers are not the real docs implementation
- fewer tools means fewer tool-call failure modes and less LLM distraction

### If removal is judged too wide for this pass

Fallback option:

- leave the tool interfaces in place
- remove all prompt references that encourage their use
- document them as unsupported/deferred in Guided Setup tests and notes

## Testing Plan

### Unit / route tests in `apps/api/src/routes/chat.test.ts`

Add or update tests for:

1. `create_connection` accepts the minimal happy-path schema when only provider + credentialMode are passed.
2. same-turn `create_connection` followed by `create_agent` without `selectedConnectionId` auto-binds the returned connection.
3. same-turn `list_compatible_connections` recommendation followed by `create_agent` without `selectedConnectionId` auto-binds the recommended trading connection.
4. omitted `selectedConnectionId` with multiple equally valid non-trading connections returns an actionable ambiguity error instead of silently choosing one.
5. prompt no longer instructs the model to use quick replies after the greeting.
6. prompt no longer instructs the model to use docs tools proactively.
7. prompt/tool descriptions no longer claim unconditional auto-selection for omitted `selectedConnectionId`.

### Optional integration-style route coverage

If existing mocks are too brittle for the connection-autowiring path, add a narrow higher-level test around `invokeOnboardingLlm()` that simulates this exact sequence:

1. LLM calls `create_connection`
2. tool returns success + `connectionId`
3. LLM then calls `create_agent` without `selectedConnectionId`
4. created agent is returned with connected trading readiness inputs

### Manual verification

1. In Guided Setup Fast Track, choose a generated Jupiter wallet path and confirm the created trading agent is not `Trading: Unconfigured`.
2. Repeat with an existing compatible trading connection so omission of `selectedConnectionId` still binds correctly.
3. For a personal-assistant flow with multiple non-trading connections, confirm the assistant asks the user which connection to use rather than silently picking one.
4. Confirm the Guided Setup conversation still offers the existing page-level "Use the form" control and that this plan did not touch it.

## Implementation Order

1. Backend connection autowiring in the onboarding tool loop
2. `create_connection` schema simplification
3. Prompt and tool-description cleanup
4. Remove docs tools from the API-local Guided Setup runtime, or at minimum remove prompt references
5. Regression tests and manual verification

## Acceptance Criteria

1. A successful same-turn `create_connection` call is sufficient for the next `create_agent` call to create a connected trading agent, even when the model omits `selectedConnectionId`.
2. A recommended compatible trading connection can be auto-bound only when the backend can resolve it deterministically.
3. Multiple equally valid non-trading connections are never silently auto-assigned.
4. The Guided Setup prompt contains no instruction to use post-greeting quick replies.
5. The Guided Setup prompt contains no proactive docs-tool instruction.
6. The `create_connection` happy-path example in the prompt matches the actual tool schema.
7. The misleading `selectedConnectionId` wording is removed.
8. The existing frontend "Use the form" control remains unchanged.

## Open Questions

1. Should docs tools be removed entirely from the API-local Guided Setup runtime in this pass, or merely de-emphasized in the prompt?
2. When exactly one compatible non-trading connection exists in the database but the user has not discussed connections yet, should the backend silently bind it or require the model to mention it in the summary first?
3. Should the backend surface an explicit field in the `create_agent` result indicating which connection was auto-assigned, so the assistant can summarize that deterministically?

## Risks

1. If autowiring precedence is underspecified, a recommended existing connection could accidentally outrank a same-turn newly created connection. This plan requires newly created same-turn connections to win.
2. If the prompt is tightened but the backend fix is skipped, the same reliability failure can still recur.
3. If docs tools are removed from `CHAT_TOOLS`, any tests or future prompt text that still mention them will need updating in the same change.

## Out Of Scope But Related

- wiring the API-local Guided Setup runtime to the real platform-docs index
- adding a dedicated post-greeting quick-reply action type for LLM-driven follow-up questions
- broader create-parity work already captured in [Fix Guided Setup Missing Agent Config](../../2026/08/07/001-fix-guided-setup-missing-agent-config/001-plan.md)
