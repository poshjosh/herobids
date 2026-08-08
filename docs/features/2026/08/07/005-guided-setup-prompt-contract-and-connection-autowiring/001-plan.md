# Plan: Guided Setup Prompt Contract And Connection Autowiring

**Feature:** Guided Setup reliability hardening
**Date:** 2026-08-07
**Status:** Implemented
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

1. Prevent Guided Setup from creating trading agents without a just-created or clearly recommended compatible connection when the omission is resolvable from surfaced context.
2. Make the `create_connection` tool contract match the happy-path prompt.
3. Remove prompt instructions that describe capabilities the runtime does not actually provide after turn one.
4. Remove docs-tool references from the prompt AND the docs tools themselves from the Guided Setup runtime so the current flow stays reliable and self-contained.
5. Surface which connection was auto-assigned so the assistant can summarize it deterministically.
6. When multiple compatible connections exist, let the user choose via rendered buttons instead of forcing the model to disambiguate from free text.
7. Preserve the existing out-of-band form switch in the frontend. This plan does not change that control.

## Non-Goals

- Implementing a **general-purpose** mid-thread `quick_replies` action system for arbitrary follow-up questions. This plan adds a single, structured connection-choice quick-reply only (Workstream 5); it does not open quick replies to every onboarding question.
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
2. auto-fill `selectedConnectionId` server-side when omission is resolvable **from surfaced context** — never from a blind database lookup
3. when several compatible connections exist, let the user choose via rendered buttons (Workstream 5) rather than relying on the model to fuzzy-match free text
4. rely on prompt wording only for user-visible explanation, not for correctness

This is better than a prompt-only fix because it closes the exact class of failure that already occurred, and it never binds a connection the creator never saw (Agent Mode Purity).

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

Resolution precedence (**surfaced context only**):

1. explicit `selectedConnectionId` from the model
2. same-turn `create_connection` result
3. same-turn `list_compatible_connections.recommended`
4. thread metadata `summary.connectionIds`

There is deliberately **no** tier-5 blind database lookup. "Surfaced context" means a connection the user has already seen in-thread — they created it, saw it recommended, or linked it earlier. Never auto-bind an unsurfaced DB row: doing so would inject a connection the creator never chose, violating Agent Mode Purity.

### Rules

#### Trading presets

If `skillPresetId` is trading-capable and `selectedConnectionId` is omitted:

- use the same-turn created connection if one exists
- else use the compatible trading connection surfaced this turn as `recommended` if one exists
- else use a single compatible-trading entry from `summary.connectionIds`
- else do not guess. Return an actionable tool error telling the model to ask the user which connection to use (or surface the choice via the disambiguation buttons in Workstream 5)

#### Non-trading presets

If `selectedConnectionId` is omitted:

- resolve only from surfaced context (a same-turn created/recommended connection, or a single compatible entry in `summary.connectionIds`)
- if multiple equally valid non-trading connections were surfaced and none is unambiguous, do not guess; return an actionable tool error so the model asks the user which one to use

#### Shared rule (no asymmetry)

Both presets now follow the same rule: **autowire only from surfaced context, and always guard capability** — a trading agent may only bind a trading connection, and a non-trading agent may only bind a non-trading connection. The earlier trading-vs-non-trading asymmetry (a trading-only single-row lookup) is removed, which keeps the behavior symmetric and Agent-Mode-Purity-compliant.

### Required changes

#### `apps/api/src/routes/chat.ts`

1. Add invocation-local connection context tracking inside `invokeOnboardingLlm()`.
2. Capture successful `create_connection` results (`connectionId`) into that context.
3. Continue capturing `list_compatible_connections.recommended` into that context.
4. Resolve the effective connection ID **inside the `invokeOnboardingLlm()` tool loop** — before dispatching the `create_agent` tool call, rewrite `tc.args.selectedConnectionId` (or call a small `resolveCreateAgentConnection()` helper). Do **not** widen the exported `executeChatAction()` signature; its fixed positional signature is relied on by ~10 test call sites.
5. Resolve from surfaced context only. Never perform a blind single-row database lookup.
6. Validate compatibility before assignment so a trading agent never auto-binds a non-trading connection, and vice versa.
7. Return explicit structured errors for ambiguous or unresolvable omission cases.
8. Add an `assignedConnectionId` field to the `create_agent` tool result and capture it into `summaryFacts.connectionIds`, so the assistant can state which connection was bound.

### Same-turn bug fix requirement

The following sequence must work with no prompt heroics:

1. `create_connection(provider='jupiter', credentialMode='generated')`
2. tool returns `connectionId='conn-123'`
3. model calls `create_agent(...)` without `selectedConnectionId`
4. backend auto-wires `conn-123`

This is the highest-priority regression to close.

### Design note: autowiring vs the confirmation summary

Autowiring does not bypass the confirmation summary. It only backstops **ID forwarding** for a connection the model already surfaced to the user. The prompt still requires the model to show the selected connection in the pre-`create_agent` summary. Because resolution is restricted to surfaced context, the summary and the bound connection can never disagree about an unseen connection — closing the tension between "autowire silently" and "confirm before creating".

## Workstream 2: Simplify `create_connection`

### Objective

Make the tool schema reflect the real Guided Setup happy path instead of forcing the prompt to emit overly verbose argument payloads.

### Decision

For Guided Setup API-local `create_connection`:

- drop `label` and `capability` from the tool schema's `required` array — keep `required: ['provider', 'credentialMode']`
- at runtime, drop only the `label` requirement and derive the label server-side
- **no** runtime change is needed for `capability`: the handler already infers it (`capability === 'trading' ? 'trading' : undefined`), and only `provider` + `label` were ever runtime-checked

The onboarding path only uses this tool for generated trading connections tied to a known provider. The runtime can derive the rest.

### Proposed contract

Preferred minimal call shape:

```ts
create_connection({ provider: 'jupiter', credentialMode: 'generated' })
```

Server-side behavior:

- keep the existing capability inference untouched
- derive a deterministic default label from the provider registry entry
- preserve the current validation that `credentialMode` must be `generated`

Example derived labels (from `listProviderRegistry()` `displayName`):

- `Hyperliquid Wallet`
- `Jupiter Wallet`
- `1inch Wallet`

### Required changes

#### `apps/api/src/routes/chat.ts`

1. Remove `label` and `capability` from the `create_connection` entry's `required` array in `CHAT_TOOLS` (leaving `required: ['provider', 'credentialMode']`).
2. In the `create_connection` runtime branch, stop requiring `label`; derive it when absent. Leave the existing capability inference untouched — no runtime change there.
3. Derive the default label as `` `${entry.displayName} Wallet` `` from the provider registry entry already looked up via `listProviderRegistry()` — no hard-coded provider→label map.
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

#### 3. Rework mid-thread quick-reply instructions

The prompt must stop implying the model can freely emit *arbitrary* `quick_replies` after the seeded greeting. But the runtime now supports **one** structured mid-thread quick-reply: the connection-choice buttons (Workstream 5).

Replace with:

- initial preset buttons are UI-provided in the greeting
- the connection-choice step may present structured buttons — these are emitted by the runtime, not free-formed by the model
- all other follow-up choices should be asked in plain language
- if the user answers with free text, continue naturally

#### 4. Remove docs-tool references (prompt text only)

Because the current Guided Setup priority is reliability, remove from the prompt:

- the system-prompt instruction to use docs tools before asking ordinary onboarding questions
- proactive mention of docs tools in the Guided Setup flow

This workstream owns only the **prompt-text** edits. Removing the docs tools from `CHAT_TOOLS` and deleting their handler is owned by Workstream 4 — there is no duplication between the two.

### Files

#### `apps/api/src/routes/chat.ts`

Update:

- `buildSystemPrompt()` body
- `CHAT_TOOLS` descriptions for `create_connection` and `create_agent.selectedConnectionId`

## Workstream 4: API Tool Surface Reduction For Reliability

### Objective

Reduce the API-local Guided Setup surface to the minimal set required for the current working flow.

### Recommended change

In this pass, remove the three docs tools from the API-local Guided Setup runtime (DECIDED — not deferred):

- `search_app_docs`
- `list_app_docs`
- `read_app_docs`

This removes their entries from `CHAT_TOOLS` and deletes the shared `search/list/read_app_docs` handler case in `executeChatAction()`. This is specifically for `apps/api/src/routes/chat.ts`, not for the worker runtime or the broader platform-docs investment.

### Reasoning

- the prompt-local guidance already carries the onboarding rules we need
- the current user request prioritizes reliability over richer docs-assisted behavior
- the current API-local handlers are placeholder responses, not the real docs implementation
- fewer tools means fewer tool-call failure modes and less LLM distraction

### Fallout

One scripted `search_app_docs` test in `chat.test.ts` exercises the placeholder handler; it must be removed or repointed in the same change (see Testing Plan).

## Workstream 5: Connection Disambiguation Branch (Rendered Buttons)

### Objective

When a trading agent has more than one compatible connection available, let the user pick one with tappable buttons instead of typing a connection name the model then has to fuzzy-match back to a `connectionId`.

### Delivery mechanism (DECIDED)

Use **rendered buttons** — a structured mid-thread `quick_replies` action emitted by the runtime — not a plain-language prose question. Rationale:

- the choice is a small, closed set
- the greeting already emits `quick_replies` buttons via `GREETING_ACTIONS`, so the action shape and the frontend renderer already exist
- buttons give one-tap selection, avoid the user spelling a connection label, and remove the model's fuzzy-match / mismatch risk
- it is mobile-friendly and consistent with the existing preset-selection buttons

This narrows the former Non-Goal: the plan now adds a **single, structured** connection-choice quick-reply, not a general-purpose LLM-driven quick-reply system.

### Branch shape

Trigger: a trading agent where the surfaced-context gate finds more than one compatible connection (or the user explicitly asks to choose).

Present up to four options as buttons:

1. Existing connection A *(contextual — see Refinement 1)*
2. Existing connection B *(contextual)*
3. **Generate a new wallet** → `create_connection({ provider, credentialMode: 'generated' })`
4. **Enter my own wallet / API keys** → `request_connection_form({ preferredProvider })`

There is no separate redundant "use an existing connection" catch-all option — the existing connections are themselves the first buttons.

### Refinement 1: Venue-context filtering

Only show an existing connection as a button when its venue is in the current setup context, OR the venue context is not yet known. If the user has already locked a venue (e.g. Hyperliquid), do not offer connections for a different venue.

### Refinement 2: Option set

The four options above are the complete set. Options 3 and 4 map to the existing `create_connection` and `request_connection_form` tools respectively — no new connection-creation surface is introduced.

### Refinement 3: Re-derive venue-coupled config on selection

When the user picks a connection whose venue differs from a previously assumed venue, re-derive venue-coupled configuration (e.g. the strategy preset) so the final agent config matches the actually chosen venue.

### Required changes

#### `apps/api/src/routes/chat.ts`

1. Add a runtime path that emits a `quick_replies` `ChatAction` listing the venue-filtered connection options plus the "generate new wallet" and "enter my own keys" choices. Model this emission on the existing `GREETING_ACTIONS` / `pendingActions` pattern.
2. Handle the user's button reply (a structured value) on the next turn, mapping it to `selectedConnectionId`, `create_connection`, or `request_connection_form`.
3. On connection selection, re-derive any venue-coupled config before `create_agent`.

## Testing Plan

### Unit / route tests in `apps/api/src/routes/chat.test.ts`

Add or update tests for:

1. `create_connection` accepts the minimal happy-path schema when only `provider` + `credentialMode` are passed, and derives the label from the provider registry. This is a **positive** test — the three existing `create_connection` tests only cover error paths and survive the schema loosening unchanged.
2. same-turn `create_connection` followed by `create_agent` without `selectedConnectionId` auto-binds the returned connection. Write this as an `invokeOnboardingLlm()` **loop-level** test modeled on the existing `wallet_created` test, not an `executeChatAction()` unit test.
3. same-turn `list_compatible_connections` recommendation followed by `create_agent` without `selectedConnectionId` auto-binds the recommended trading connection (also a loop-level test).
4. omitted `selectedConnectionId` with multiple equally valid connections and no disambiguating surfaced context returns an actionable ambiguity error instead of silently choosing one.
5. the `create_agent` result includes `assignedConnectionId` and it is captured into `summary.connectionIds`.
6. no **unsurfaced** database connection is ever auto-bound: a compatible active connection exists in the DB but was never surfaced in-thread → it must not be bound.
7. prompt no longer instructs the model to emit arbitrary quick replies after the greeting.
8. prompt no longer instructs the model to use docs tools proactively, and the three docs tools are absent from `CHAT_TOOLS`. Update or remove the existing scripted `search_app_docs` test accordingly.
9. prompt/tool descriptions no longer claim unconditional auto-selection for omitted `selectedConnectionId`.
10. disambiguation: a trading agent with multiple compatible connections emits a `quick_replies` action whose options are venue-filtered and include the "generate new wallet" and "enter my own keys" choices.

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
4. For a trading flow with multiple compatible connections, confirm rendered buttons appear listing the venue-filtered connections plus "generate new wallet" and "enter my own keys", and that picking one binds it.
5. Confirm the Guided Setup conversation still offers the existing page-level "Use the form" control and that this plan did not touch it.

## Implementation Order

1. Backend connection autowiring in the onboarding tool loop
2. `create_connection` schema simplification
3. Prompt and tool-description cleanup
4. Remove docs tools from the API-local Guided Setup runtime (`CHAT_TOOLS` + handler)
5. Connection disambiguation branch with rendered buttons
6. Regression tests and manual verification

## Acceptance Criteria

1. A successful same-turn `create_connection` call is sufficient for the next `create_agent` call to create a connected trading agent, even when the model omits `selectedConnectionId`.
2. A recommended compatible trading connection can be auto-bound only when it was surfaced in-thread; an unsurfaced DB connection is never auto-bound.
3. Multiple equally valid connections are never silently auto-assigned.
4. The `create_agent` result exposes `assignedConnectionId`, and the assistant can state which connection was bound.
5. A trading agent with multiple compatible connections presents rendered choice buttons (venue-filtered + generate-new + enter-own-keys).
6. The Guided Setup prompt contains no instruction to emit arbitrary post-greeting quick replies.
7. The Guided Setup prompt contains no proactive docs-tool instruction, and the three docs tools are absent from `CHAT_TOOLS`.
8. The `create_connection` happy-path example in the prompt matches the actual tool schema (`provider` + `credentialMode`).
9. The misleading `selectedConnectionId` wording is removed.
10. The existing frontend "Use the form" control remains unchanged.

## Resolved Questions

1. **Docs tools** — removed entirely from the API-local Guided Setup runtime in this pass (Workstream 4), not merely de-emphasized.
2. **Single unsurfaced DB connection** — never silently bound. The backend resolves only from surfaced context; if nothing is surfaced it asks (or shows the disambiguation buttons).
3. **Auto-assigned connection field** — yes. `create_agent` returns `assignedConnectionId`, captured into `summary.connectionIds`.

## Risks

1. If autowiring precedence is underspecified, a recommended existing connection could accidentally outrank a same-turn newly created connection. This plan requires newly created same-turn connections to win.
2. If the prompt is tightened but the backend fix is skipped, the same reliability failure can still recur.
3. Removing the docs tools from `CHAT_TOOLS` breaks any test or prompt text that still mentions them; they must be updated in the same change (the scripted `search_app_docs` test is the known one).
4. Adding a structured mid-thread quick-reply widens the runtime action surface. Keep it narrow — only the connection-choice buttons — so it does not drift into a general LLM-driven quick-reply system.

## Out Of Scope But Related

- wiring the API-local Guided Setup runtime to the real platform-docs index
- a general-purpose post-greeting quick-reply action type for arbitrary LLM-driven follow-up questions (this plan adds only the narrow connection-choice buttons)
- broader create-parity work already captured in [Fix Guided Setup Missing Agent Config](../../2026/08/07/001-fix-guided-setup-missing-agent-config/001-plan.md)

## Outstanding Issues (Post-Implementation)

### Workstream 1: Backend Connection Autowiring

#### MEDIUM
- **M1**: No error-path integration test for autowiring ambiguity in the tool loop
- **M2**: TOCTOU between autowiring validation and transaction validation — document rationale
- **M3**: `validateSurfacedConnections` fetches ALL user connections instead of targeted `WHERE id IN`
- **M4**: `custom` preset agents with trading skills won't get trading connections autowired (pre-existing limitation)
- **M5**: `assignedConnectionId` in result only reflects first connection ID (fine for now, connections always 0-1)

#### LOW
- **L1**: Variable naming `resolvedConnections` is a context, not resolved objects — consider renaming to `connectionContext`
- **L2**: `validateSurfacedConnections` silently drops stale IDs — add code comment explaining intent
- **L5**: Missing loop-level test for incompatible explicit `selectedConnectionId`

### Workstream 3: Prompt Contract Cleanup

#### MEDIUM
- **M1**: `CHAT_TOOLS` descriptions are not contract-tested (`selectedConnectionId`, `create_connection`)
- **M3**: Prompt wording inconsistency: "next create_agent call" vs "follows immediately"

#### LOW
- **L1**: No positive assertion that `list_available_skills` survived docs-tool removal
- **L2**: Docs-tool test could miss reworded references
- **L3**: `buildSystemPrompt` export widens public API surface

### Workstream 5: Connection Disambiguation Buttons

#### MEDIUM
- **M1**: No integration test verifies venue-hint threading in the tool-loop disambiguation path
- **M2**: `BUTTON_VALUE_RE` is case-sensitive — consider making it case-insensitive for defensive hardening

#### LOW
- **L1**: `buildResumeFallback` for `connection_selected` is generic (doesn't name the connection)
- **L2**: "Generate a new wallet" button always shown regardless of venue wallet-generation capability
- **L3**: `detectPresetFromContent` runs unnecessarily on button-reply content
- **L4**: Regex character class may need future-proofing for connection ID format changes
