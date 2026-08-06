# Plan: Guided Setup — Inline Connection Form

**Feature:** Guided Setup credential simplification (002)
**Date:** 2026-08-05
**Status:** Draft

## Summary

The AI-assisted Guided Setup flow currently breaks when agent creation needs a connection. The LLM tells the user it cannot open the setup UI, asks them to leave the chat and configure credentials manually, and the happy path stalls. This is worse for OAuth-based providers such as Gmail: even if the inline form were shown, the current guided flow does not preserve enough state to resume cleanly after the redirect.

The root cause is broader than a missing tool. The frontend can render an inline connection form, and the backend can receive form results, but the LLM has no explicit tool to request the form, the server never emits the `form` `ChatAction`, the action-result path does not resume the LLM turn, cancel results are rejected, and OAuth return/resume is not wired for Guided Setup.

This plan connects the existing inline-form infrastructure to the LLM so that, when a connection is needed, the chat renders the secure setup form inline, resumes after completion or cancellation, and supports OAuth providers without losing thread state. Secrets remain outside LLM context and message history.

**Scope:** Guided Setup chat only. The plain create-agent form keeps its current UX, aside from compatible shared `ProviderSetupForm` prop extensions if needed. Secrets are never entered via chat text.

## Relationship to Existing Work

This is a follow-up to `docs/features/2026/08/01/005-ai-first-ux/002-onboarding-chat.md`. That plan established the Guided Setup chat, the `ChatAction` model (`quick_replies` | `form` | `confirm`), the inline `ProviderSetupForm` rendering in `GuidedSetupActionRenderer.tsx`, and the `POST /chat/threads/:id/actions/:actionId` result endpoint. This plan completes the `form` action path that was scaffolded but never connected end-to-end.

The plain create-agent flow already solves OAuth redirect/resume with a proven, tested pattern that this plan **reuses rather than reinvents**:

- `apps/web/src/features/agents/AgentsPage.tsx` — `saveCreateAgentOAuthDraft` / `loadCreateAgentOAuthDraft` / `clearCreateAgentOAuthDraft` (sessionStorage key `create-agent-oauth-draft-v1`) plus the `oauthReturn=1` handler (guarded by a `handledOauthReturnRef` to run once) that restores the draft, merges the returned `connectionId`, invalidates connection queries, and strips the OAuth query params.
- `ProviderSetupForm` already exposes `oauthReturnTo` and `onBeforeOAuthRedirect` props and drives the redirect via `connectionsApi.beginOAuth(providerId, { returnTo })`.

Guided Setup mirrors this exact structure, differing only in what it stores (thread/action context) and what it does on return (submit the action result and resume the LLM).

## Current State (verified in code)

- **Frontend renders inline connection forms** — `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx` handles `action.type === 'form' && action.form === 'connection'` by rendering `<ProviderSetupForm inline defaultCapability="trading" />`. ✅
- **Shared provider form already supports credential and OAuth providers** — `ProviderSetupForm` groups trading, email, and other providers, and can begin OAuth redirects. ✅
- **Backend receives form results** — `POST /chat/threads/:id/actions/:actionId` handles `{ connectionId }`, appends it to thread metadata, and returns a static acknowledgement. ✅
- **Action-result cancellation is not supported** — the renderer sends `{ cancelled: true }` on dismiss, but the backend rejects anything except a `connectionId`. Note the endpoint body is wrapped: `ActionResultSchema = { result: unknown }`, so submissions arrive as `result.connectionId` / `result.cancelled`, not at the top level. ❌
- **LLM has no tool to request the form** — `CHAT_TOOLS` exposes `search_app_docs`, `list_app_docs`, `read_app_docs`, `list_compatible_connections`, and `create_agent`, but no `request_connection_form`. ❌
- **Server never emits a `form` action** — `LlmInvocationResult.actions` is declared but never populated in `invokeOnboardingLlm`. Only the post-creation `confirm` card is emitted today. ❌
- **OAuth return/resume is missing for Guided Setup** — the inline form can redirect for OAuth, but the guided chat flow does not pass an `oauthReturnTo`, preserve the pending thread/action context, or auto-submit the returned `connectionId`. The reusable create-agent OAuth-draft pattern above exists and is tested but is not yet wired into Guided Setup. ❌
- **`ProviderSetupForm` cannot be steered by capability/provider hint** — its `defaultCapability` prop is typed as the literal `'trading'` only, and there is no prop to preselect a specific provider (e.g. `gmail`). Any capability/provider hint from the LLM requires widening these props. ❌
- **System prompt is vague** — it says "request the secure connection form action" but names no tool, so the LLM hallucinates or refuses. ❌
- **Non-trading presets still inherit trading assumptions** — `capital` is required and trading payload fields are synthesized even for personal-assistant/custom flows. ❌

## Architecture

```
┌──────────┐  POST /chat/threads/:id/messages   ┌───────────┐
│  Web UI  │ ─────────────────────────────────→ │  API      │
│  (React) │ ←── { content, actions:[form] } ── │  (Fastify)│
└──────────┘                                    └─────┬─────┘
      │                                              │
      │ GuidedSetupActionRenderer                    │ invokeOnboardingLlm
      │  renders <ProviderSetupForm inline/>         │  tool loop
      │                                              │
      │ OAuth redirect (optional)                    │
      │  returnTo=/agents/new?guided=1&oauthReturn=1 │
      │                                              │
      │ POST /chat/threads/:id/actions/:actionId     │ request_connection_form
      │  { connectionId } or { cancelled: true }     │  tool
      └──────────────────────────────────────────────→│
                                                     │ validate + update thread
                                                     │ resume onboarding LLM
                                                     └──────────────────────
```

### Key Design Decisions

1. **`request_connection_form` is the only UI trigger.** The server must not auto-open the connection form based on an empty `list_compatible_connections` result. The LLM explicitly decides when to request the form.

2. **The tool carries UI hints.** `request_connection_form` accepts optional arguments such as `preferredCapability` and `preferredProvider`. The tool requests intent; the server converts that into a structured `ChatAction` for the frontend.

3. **Secrets never transit the LLM.** The user fills the inline form; the result endpoint only reports linkage state such as `connectionId` or cancellation.

4. **OAuth providers are first-class in scope.** Guided Setup must preserve thread/action context across OAuth redirects, restore the thread on return, submit the resulting `connectionId`, and continue the conversation automatically.

5. **The action-result endpoint resumes the conversation.** A successful form submission must not end with a static acknowledgement. After updating thread state, the server immediately re-invokes the onboarding LLM and returns the next assistant message and actions.

6. **Action results are validated and deduplicated.** The backend validates that a submitted connection belongs to the user and is active, deduplicates thread metadata, handles cancellation as a first-class non-error path, and emits at most one connection-form action per assistant turn.

7. **Non-trading presets have an explicit payload contract.** In Guided Setup v1, `personal-assistant` and `custom` are treated as non-trading/intelligence flows: `capital` is optional, and trading-only fields are omitted unless the flow is explicitly a trading-capable preset.

8. **OAuth resume reuses the existing create-agent pattern.** Guided Setup does not invent new sessionStorage/return machinery. It mirrors `AgentsPage`'s `saveCreateAgentOAuthDraft` / `loadCreateAgentOAuthDraft` / `clearCreateAgentOAuthDraft` + `handledOauthReturnRef` return handler, storing thread/action context instead of form state.

9. **Resume is loop-safe and idempotent.** Re-invoking the LLM after a form result must not re-open the form the user just dismissed, and must not double-fire on OAuth return (refresh, back button, React strict-mode double effect). A cancellation is recorded in thread state so the prompt can react, and the auto-submit-on-return is guarded by a once-only ref plus a server-side already-processed check keyed on the action.

## Resolved Decisions

1. **OAuth-based providers are in scope.** Gmail and other supported OAuth providers must work end-to-end in Guided Setup.
2. **`request_connection_form` is the only trigger.** No server-side auto-trigger on empty compatible-connection results.
3. **Step 6 stays in this plan.** The non-trading payload contract is part of the same UX defect and remains in scope here.

## Implementation Steps

### Step 1: Add a `request_connection_form` tool to `CHAT_TOOLS`

In `apps/api/src/routes/chat.ts`, add a tool definition with optional UI hints:

```typescript
{
  name: 'request_connection_form',
  description: 'Request that the frontend render the secure connection setup form inline in the chat. Call this when the user needs to connect a provider and the guided flow should continue after setup.',
  inputSchema: {
    type: 'object',
    properties: {
      preferredCapability: {
        type: 'string',
        enum: ['trading', 'email', 'other'],
        description: 'Optional hint for which provider family the form should open with.',
      },
      preferredProvider: {
        type: 'string',
        description: 'Optional provider ID to preselect when the setup target is known, e.g. gmail.',
      },
    },
  },
}
```

`preferredProvider` is free-form text emitted by the LLM. The server must normalize it against the provider catalog and drop it if it does not match a known active provider, so a hallucinated ID never reaches the frontend preselect. `preferredCapability` is validated against the enum by the tool schema.

### Step 2: Handle `request_connection_form` in `executeChatAction`

Add a case that returns structured JSON the tool loop can detect and normalize:

```typescript
case 'request_connection_form': {
  return JSON.stringify({
    form: 'connection',
    preferredCapability: parsedArgs.preferredCapability ?? null,
    preferredProvider: parsedArgs.preferredProvider ?? null,
    message: 'Connection form requested.',
  });
}
```

The returned structure is for server-side normalization only; the assistant should never describe the raw tool payload to the user.

### Step 3: Emit the `form` `ChatAction` only from explicit tool calls

In `invokeOnboardingLlm`, track a `pendingActions: ChatAction[]` array. After each tool call:

- If `tc.name === 'request_connection_form'`, push exactly one action such as:

```typescript
{
  id: `connection-form-${round}`,
  type: 'form',
  form: 'connection',
  props: {
    preferredCapability,
    preferredProvider,
  },
}
```

- Do not emit a form action from `list_compatible_connections`.
- Deduplicate so multiple `request_connection_form` calls in the same assistant turn still yield one rendered form action.

Return `pendingActions` on all `LlmInvocationResult` return paths.

### Step 4: Persist and return `actions` in the route handler

In `POST /chat/threads/:id/messages`, merge `llmResponse.actions` with the existing post-creation `confirm` action:

```typescript
const actions: ChatAction[] = [
  ...(llmResponse.actions ?? []),
  ...(llmResponse.createdAgent ? [postCreationConfirmAction] : []),
];
```

Persist `actions` on the assistant message and return them in the response.

### Step 5: Widen `ProviderSetupForm` props and honor tool hints in the renderer

The hints from Step 1/3 cannot be passed to `ProviderSetupForm` today: `defaultCapability` is typed as the literal `'trading'` only, and there is no provider-preselect prop. This step makes the prop-widening an explicit, non-optional task because provider preselect is central to the first-class OAuth/Gmail goal.

Shared form work (`apps/web/src/features/setup/ProviderSetupForm.tsx`):

- Widen `defaultCapability` from `'trading'` to `'trading' | 'email' | 'other'`. Extend `defaultProviderChoice` so an `'email'`/`'other'` capability defaults to the first provider in that group (mirroring the existing trading branch), falling back to the custom entry when the group is empty.
- Add an optional `initialProviderId?: string` prop that, when set and present in the catalog, seeds `providerChoice` ahead of the capability default. This is additive and does not change existing call sites.

Renderer work (`GuidedSetupActionRenderer.tsx`):

- Read `action.props.preferredCapability` and `action.props.preferredProvider`.
- Pass `defaultCapability={preferredCapability}` when present (omit to fall back to today's behavior) and `initialProviderId={preferredProvider}` when present.
- Keep the inline form rendering in the chat; do not introduce a separate setup page flow for Guided Setup.

### Step 6: Wire OAuth return/resume for Guided Setup by mirroring the existing pattern

Because Gmail and other supported OAuth providers are in scope, Guided Setup must resume after redirect. **Do not build new machinery** — mirror the proven, tested create-agent pattern in `apps/web/src/features/agents/AgentsPage.tsx` (`saveCreateAgentOAuthDraft` / `loadCreateAgentOAuthDraft` / `clearCreateAgentOAuthDraft`, and the `handledOauthReturnRef`-guarded `oauthReturn=1` effect).

Frontend work:

- Add a guided-setup draft helper set analogous to the create-agent one (sessionStorage key `guided-setup-oauth-draft-v1`), storing at least `threadId` and `actionId`.
- When rendering a connection-form action, pass `oauthReturnTo="/agents/new?guided=1&oauthReturn=1&threadId=<threadId>&actionId=<actionId>"` and use `onBeforeOAuthRedirect` to persist the draft (exactly as `AgentsPage` uses `saveCreateAgentOAuthDraft`).
- On return to `/agents/new`, add a `handledOauthReturnRef`-guarded effect that detects `oauthReturn=1`, restores/loads the thread, and if `status=ok` with `connectionId` present, submits the action result to `/chat/threads/:id/actions/:actionId`. The once-only ref plus draft clear prevents double-submit on refresh/back/strict-mode.
- After handling the return, clear the draft and strip the OAuth query params (`oauthReturn`, `setup`, `status`, `error`, `connectionId`, `guided`, `threadId`, `actionId`), matching the existing param-stripping logic.

Backend compatibility:

- Reuse the existing connection OAuth return-to mechanism; no new route is required.
- Preserve the existing callback behavior of appending `status`, `setup`, and `connectionId` to the frontend return URL.
- The idempotency guarantee for the resumed LLM turn lives in Step 7 (server-side already-processed check), so a duplicate return that slips past the client ref still cannot double-resume.

### Step 7: Validate action results and auto-continue the conversation

The endpoint body is wrapped as `{ result: unknown }`, so read `result.connectionId` / `result.cancelled` (not top-level fields).

In `POST /chat/threads/:id/actions/:actionId`:

- Accept both `{ result: { connectionId } }` and `{ result: { cancelled: true } }`.
- For `connectionId`, validate that the connection exists, belongs to the current user, and is active before updating thread metadata (the endpoint does not do this today — it appends blindly).
- Deduplicate `summary.connectionIds` so repeated submissions do not grow the list.
- **Idempotency:** record processed action IDs in thread metadata (e.g. `summary.processedActionIds`) and no-op with the current thread state if the same `actionId` is submitted again. This is the server-side backstop for the client once-only ref in Step 6.
- For cancellation, record the dismissal in thread state (e.g. `summary.step = 'connection_form_cancelled'`) without treating it as an API error.

Resuming the LLM requires a small change to `invokeOnboardingLlm`, which today derives all context from persisted messages + the `summaryBlock`. Rather than introduce a separate "transient event" parameter, **reuse the existing `summaryBlock` channel**: write the outcome into `summary.step` (`connection_linked` or `connection_form_cancelled`) and the linked `connectionIds`, then call `invokeOnboardingLlm` with the updated metadata. The prompt (Step 8) instructs the LLM how to react to those `step` values.

Loop-safety on cancellation: the system prompt must state that after `step: 'connection_form_cancelled'` the assistant must not immediately call `request_connection_form` again for the same need — it should acknowledge and offer alternatives (reuse an existing connection, switch to the form, or continue without). Without this, re-invoking the LLM in the same state re-opens the form the user just dismissed.

Single-message guarantee: persist exactly one assistant message on the resume path — the resumed LLM output — replacing today's static "Connection linked successfully" acknowledgement rather than appending to it.

Persist and return the resumed assistant message plus any actions. This closes the happy-path dead-end: the user should not have to send another manual message after linking Gmail or another provider.

### Step 8: Update the system prompt

In `buildSystemPrompt()`, replace the vague instruction with explicit tool guidance:

> When the user needs to connect a provider, call `list_compatible_connections` first. If an existing active compatible connection works, reuse it. If the user needs a new provider connection, call `request_connection_form` with the best available hint, such as `preferredCapability` or `preferredProvider`. Never ask the user to type secrets, API keys, OAuth codes, or passwords into the chat.

Also tighten the preset-specific flow:

- **Trading presets:** capital is required; connection setup may be required; strategy and execution defaults are trading-only.
- **Personal assistant / custom presets:** ask only for the minimum needed; do not ask for capital unless the flow has explicitly become trading-capable.

### Step 9: Make the non-trading payload contract explicit

To fix the trading assumptions in non-trading Guided Setup flows:

- In `GuidedSetupCreateAgentInput`, make `capital` optional.
- In the `create_agent` tool schema, remove `capital` from `required`.
- In `buildCreateAgentPayload`, only include trading-only fields when the preset is trading-capable (`capabilityMode === 'hybrid'`).
- For `personal-assistant` and `custom` in Guided Setup v1:
  - omit `capital` when absent
  - omit `strategyPreset`
  - omit `strategy`
  - omit `executionDefaults`
  - include `selectedConnectionId` only when a compatible provider is actually required or chosen
- Fix `synthesizePrompt` and any name/prompt synthesis that interpolates `capital`: with `capital` now optional, the trading default (`Grow this portfolio with ${capital} USDC allocation`) must not render `undefined`. Guard the interpolation (omit the allocation clause when capital is absent) and keep the personal-assistant/custom branches capital-free.
- Update prompt text from "The user must specify capital" to "The user must specify capital for trading agents."

## Scope

### In Scope

- Add `request_connection_form` tool plus handler.
- Emit `form` `ChatAction` only from explicit `request_connection_form` calls.
- Return and persist `actions` from `invokeOnboardingLlm` through the message route.
- Extend the guided-chat renderer and shared provider form props as needed to support hinted provider setup.
- Widen `ProviderSetupForm` `defaultCapability` to `trading | email | other` and add an `initialProviderId` preselect prop.
- Wire Guided Setup OAuth return/resume for Gmail and other supported OAuth providers by reusing the existing create-agent OAuth-draft pattern.
- Validate and deduplicate connection action results, with idempotent re-submits and a loop-safe cancellation path.
- Resume the LLM automatically after connection success or cancellation.
- Update the system prompt.
- Make `capital` optional for non-trading presets and codify the non-trading payload contract.
- Tests for the new tool path, OAuth resume path, cancellation path, and non-trading payload.

### Out of Scope

- General chat ("ask anything").
- Entering secrets via chat text.
- New DB schema or new backend routes.
- Redesigning the plain create-agent form UX.
- Wallet generation changes beyond whatever the shared `ProviderSetupForm` already supports.

## Testing

- **Unit (API):** `executeChatAction` returns the normalized form-request JSON for `request_connection_form`, including optional provider hints, and drops a `preferredProvider` that is not in the provider catalog.
- **Unit (API):** `invokeOnboardingLlm` emits a `form` action only when `request_connection_form` is called, and deduplicates multiple calls in one turn.
- **Unit (API):** `POST /chat/threads/:id/actions/:actionId` reads `result.connectionId` / `result.cancelled`, accepts cancellation, validates owned active `connectionId`s (rejects a connection owned by another user), deduplicates metadata, and resumes the onboarding flow.
- **Unit (API):** submitting the same `actionId` twice is idempotent — no duplicate resume, no duplicate assistant message, no growth of `connectionIds`.
- **Unit (API):** after `step: 'connection_form_cancelled'`, the resumed turn does not re-emit a `request_connection_form` action for the same need.
- **Unit (API):** `buildCreateAgentPayload` omits trading-only fields for `personal-assistant` and `custom`, includes them for trading-capable presets, and `synthesizePrompt` produces no `undefined` when `capital` is absent.
- **Unit (API):** secrets are never placed into the LLM message list — connection results surfaced to `invokeOnboardingLlm` contain only linkage state (`connectionId`, `step`), never credential material.
- **Frontend:** widened `ProviderSetupForm` defaults to the correct provider group for `email`/`other` capability and preselects `initialProviderId` when present, without breaking existing trading call sites.
- **Frontend:** Guided Setup OAuth return handling reloads the thread, auto-submits the returned `connectionId` exactly once (guarded ref), and clears resume query params and the sessionStorage draft.
- **E2E:** A new user creating a trading agent with no compatible connection sees the inline connection form, links a connection, and the guided conversation continues without requiring an extra manual message.
- **E2E:** A user selecting Gmail or another supported OAuth provider from Guided Setup is redirected back to `/agents/new`, the thread resumes automatically, and agent creation can continue.
- **E2E:** Dismissing the inline connection form does not produce an API error, the assistant responds with the next appropriate prompt, and does not immediately re-open the same form.
- **E2E:** A new user creating a personal assistant or custom non-trading agent is not asked for capital and does not receive an unsolicited trading connection prompt.
