# Plan: Guided Setup — Gmail Resume After OAuth

**Feature:** Guided Setup OAuth resume continuation (001)
**Date:** 2026-08-06
**Status:** Draft

## Summary

The Guided Setup chat successfully opens the Gmail connection form, redirects through OAuth, returns to `/agents/new`, restores the thread, and submits the returned `connectionId` back to the action-result endpoint. The backend updates thread metadata and re-invokes the onboarding LLM. However, instead of continuing the agent-creation flow, the resumed assistant responds with the generic fallback:

> I understand. How can I help you further with setting up your agent?

This means the resume plumbing is mostly working, but the resumed LLM call is under-specified. The model receives persisted message history that ends on its own prior assistant turn, plus a weak summary-block signal (`step: 'connection_linked'`). In that state, the model may return empty content or a generic continuation, and the backend currently turns that into a dead-end fallback instead of a deterministic next step.

This plan strengthens the post-OAuth resume contract so that Guided Setup continues reliably after Gmail connection success. The fix is not to rework OAuth transport again; it is to make the resumed LLM invocation explicit about what just happened and what it must do next.

**Scope:** Guided Setup resume path only. This plan does not redesign the broader onboarding flow, change the plain create-agent form, or alter provider-link transport.

## Relationship to Existing Work

This is a follow-up to:

- `docs/features/2026/08/05/002-guided-setup-inline-connection-form/001-plan.md`
- `docs/features/2026/08/01/005-ai-first-ux/002-onboarding-chat.md`

The prior Guided Setup inline-form work solved several foundational issues:

- explicit `request_connection_form` tool
- inline `form` ChatAction rendering
- Guided Setup OAuth draft persistence and return handling
- action-result validation and idempotency
- automatic LLM re-invocation after connection success/cancellation

What remains is a narrower but important defect: **the resume invocation lacks a strong event prompt**, so the model does not reliably continue the flow after Gmail has been linked.

## Current State (verified in code)

- **OAuth return is wired** — `apps/web/src/features/chat/GuidedSetupPanel.tsx` restores the draft, reloads the thread, and submits `{ connectionId }` to `/chat/threads/:id/actions/:actionId`. ✅
- **Action-result endpoint resumes the LLM** — `apps/api/src/routes/chat.ts` updates thread metadata (`step: 'connection_linked'`) and calls `invokeOnboardingLlm(...)`. ✅
- **Resume history ends on an assistant turn** — the endpoint passes `threadResult.messages` into `invokeOnboardingLlm`, and those persisted messages end with the assistant message that opened the Gmail form. There is no fresh user turn describing the completed OAuth event. ❌
- **The resume signal is only in the summary block** — the model sees `summary.step = 'connection_linked'` and `connectionIds`, but no explicit event text such as “the user just connected Gmail successfully; continue setup.” ❌
- **Preset/context is weakly structured** — the conversation may contain `preset:personal-assistant` only as prior message text; the resume logic does not inject a structured reminder of the active setup goal. ❌
- **Generic fallback masks the failure** — if the model returns empty content with no tool calls, `invokeOnboardingLlm` falls back to `I understand. How can I help you further with setting up your agent?`, which stalls the happy path. ❌
- **The flow is especially fragile for email-management assistants** — once Gmail is linked, the correct next step should be obvious (continue defining the assistant and/or summarize for creation), but the runtime does not force that continuation strongly enough. ❌

## Root Cause

The bug is not primarily in OAuth transport. The core defect is that **the resume invocation is treated like a normal continuation of the prior chat instead of a discrete post-action event**.

Today the backend does this:

1. persist prior visible chat messages
2. update `summary.step = 'connection_linked'`
3. call `invokeOnboardingLlm(...)` with the same visible history

That leaves the model to infer, from metadata alone, that an external event occurred and that it must continue the agent-creation flow. Because the history ends on the assistant’s own earlier instruction to open Gmail, the resumed invocation is structurally ambiguous:

- there is no new user message to answer
- there is no explicit tool-result-derived resume event in the visible prompt
- the fallback path is generic rather than flow-specific

As a result, the model can legitimately produce an empty or bland continuation, which the backend then degrades into the generic “How can I help you further?” response.

## Key Design Decisions

1. **Treat OAuth return as a first-class resume event.** The resumed LLM call must include an explicit textual event describing what just happened, not just a metadata step value.
2. **Do not depend on the model inferring state transitions from summary JSON alone.** The summary block remains useful, but it is insufficient as the only resume signal.
3. **Resume should end on a user-like turn or equivalent explicit instruction.** The model should be prompted as though a fresh event arrived that requires a next assistant action.
4. **Fallbacks must preserve onboarding momentum.** If the model still returns nothing useful, the backend should emit a Guided Setup-specific continuation, not a generic open-ended chat fallback.
5. **The fix should remain local to Guided Setup.** Avoid introducing a generalized event framework unless the local patch proves too awkward.

## Resolved Decisions

1. **This is a distinct follow-up plan.** The prior inline-form plan handled transport and action plumbing; this plan handles LLM continuation quality after resume.
2. **The primary issue is prompt/runtime structure, not Gmail OAuth itself.** The connection succeeds; continuation fails.
3. **Guided Setup should continue automatically after successful Gmail linking.** The user should not need to manually re-prompt the assistant.

## Implementation Steps

### Step 1: Add an explicit resume-event prompt channel to `invokeOnboardingLlm` — **PENDING**

Extend `invokeOnboardingLlm(...)` in `apps/api/src/routes/chat.ts` to accept an optional resume-event input, for example:

```typescript
interface OnboardingResumeEvent {
  kind: 'connection_linked' | 'connection_form_cancelled';
  connectionId?: string;
  providerHint?: string;
  actionContext?: 'guided_setup_connection';
}
```

This event is **not** persisted as a chat message row. It is transient invocation context.

The event should be rendered into the LLM prompt in an explicit natural-language block, for example:

> Resume event: The user just linked a provider connection successfully during Guided Setup. The connection is now available. Continue creating the agent from the current setup state. Do not ask the user to reconnect the provider.

For cancellation:

> Resume event: The user dismissed the provider connection form during Guided Setup. Acknowledge that and offer alternatives. Do not immediately request the same form again.

### Step 2: Ensure the resumed prompt ends with actionable continuation context — **PENDING**

Do not rely only on replaying prior persisted messages. When resuming after OAuth or form completion, append a transient user-like event message or equivalent final instruction so the model is responding to a fresh event, not to its own earlier assistant text.

Two acceptable implementations:

- **Preferred:** append a transient `user` message such as `System event: the Gmail connection was linked successfully. Continue the Guided Setup flow.`
- **Alternative:** append a dedicated “resume instructions” block after the summary block and before replayed history, if provider behavior proves better with that ordering.

Whichever shape is chosen, keep it out of persisted message history.

### Step 3: Pass the resume event from the action-result endpoint — **PENDING**

In `POST /chat/threads/:id/actions/:actionId`, after validating and updating metadata:

- for success, call `invokeOnboardingLlm(...)` with `resumeEvent: { kind: 'connection_linked', connectionId, providerHint }`
- for cancellation, call `invokeOnboardingLlm(...)` with `resumeEvent: { kind: 'connection_form_cancelled' }`

If practical, derive `providerHint` from the linked connection row so the event can say “Gmail” rather than a raw connection ID.

### Step 4: Strengthen structured setup state used on resume — **PENDING**

The resumed model call should not have to reconstruct the entire setup intent from plain-text history.

When feasible in the Guided Setup flow:

- persist `summary.preset` when the user selects `preset:personal-assistant`, `preset:custom`, or a trading preset
- persist other high-value setup facts that affect next-step reasoning, especially when they are already obvious from a tool decision or quick-reply choice

At minimum for this fix, ensure the prompt presented during resume clearly reflects:

- active preset / setup type
- current step (`connection_linked`)
- available linked connection(s)

### Step 5: Make the generic fallback resume-aware — **PENDING**

The current fallback in `invokeOnboardingLlm(...)` is too generic for resumed onboarding turns:

```typescript
content || 'I understand. How can I help you further with setting up your agent?'
```

Replace this with a resume-aware fallback path:

- if `resumeEvent.kind === 'connection_linked'`, emit a concrete continuation such as:
  - acknowledge the successful connection
  - continue with the next required question for the active preset
  - or summarize what is already known and ask for the remaining minimum data
- if `resumeEvent.kind === 'connection_form_cancelled'`, emit a cancellation-aware fallback that offers alternatives and does not re-open the form

The fallback should still be deterministic and safe even if the model returns empty content.

### Step 6: Tighten the system prompt for resumed turns — **PENDING**

Update `buildSystemPrompt()` so the prompt explicitly tells the model how to behave after resume events, not just after summary `step` values.

Example addition:

> When the runtime resumes you after a connection action, you will receive an explicit resume event. Treat it as the latest user-visible state change. If the event says a connection was linked successfully, continue the setup flow from that point and do not ask the user to reconnect the provider.

Also specify that for personal-assistant email-management flows, once Gmail is linked, the assistant should proceed to the next missing setup field or summarize for creation rather than switching to generic conversation.

### Step 7: Keep resume loop-safe and idempotent — **PENDING**

Preserve the existing `processedActionIds` idempotency backstop and ensure the new resume-event prompt does not cause repeat form emission.

In particular:

- a successful link must not re-request the connection form
- a cancellation must not instantly re-open the same form
- duplicate OAuth returns must not generate duplicate assistant messages

### Step 8: Consider a narrow local abstraction instead of over-generalizing — **PENDING**

If the code starts to branch awkwardly around success/cancellation resume cases, extract a small local helper in `apps/api/src/routes/chat.ts`, such as:

```typescript
function buildResumePromptBlock(event: OnboardingResumeEvent | null): string
```

or

```typescript
function buildResumeMessages(event: OnboardingResumeEvent | null): LlmMessage[]
```

Do not build a platform-wide event bus or generalized chat workflow framework as part of this fix.

## Scope

### In Scope

- Explicit resume-event prompt context for Guided Setup
- Passing connection-success / cancellation resume events into `invokeOnboardingLlm`
- Resume-aware fallback behavior
- Stronger structured setup context for resumed turns where needed
- Tests covering the Gmail success path and generic-empty-output fallback path

### Out of Scope

- Reworking the Gmail OAuth transport or callback endpoints
- Redesigning the create/edit agent form connection UX
- Broad general-chat resume/event architecture
- Rewriting the entire Guided Setup prompt strategy
- Marketplace ranking, billing gates, or unrelated scratchpad items

## Testing

- **Unit (API):** `invokeOnboardingLlm` with a `connection_linked` resume event appends the explicit resume instructions/event message and does not rely solely on `summary.step`.
- **Unit (API):** when the provider returns empty content and no tool calls during a `connection_linked` resume, the backend emits a Guided Setup-specific fallback instead of `I understand. How can I help you further...`.
- **Unit (API):** when the provider returns empty content and no tool calls during a normal non-resume turn, the generic fallback behavior remains unchanged unless intentionally updated.
- **Unit (API):** the action-result endpoint passes a success resume event after a valid linked connection and a cancellation resume event after `{ cancelled: true }`.
- **Unit (API):** resume-event success does not emit a new connection-form action for the same need.
- **Unit (API):** duplicate action submissions remain idempotent and do not create duplicate assistant resume messages.
- **Unit (API):** if `summary.preset` is added/strengthened, personal-assistant Gmail flows preserve that preset context across resume.
- **E2E:** Guided Setup personal-assistant flow requesting Gmail, completing OAuth, and returning to `/agents/new` continues automatically with the next setup step rather than a generic open-ended response.
- **E2E:** Guided Setup Gmail resume still works when the page reloads on the OAuth return URL once, with no duplicate continuation.
- **E2E:** dismissing the connection form still yields a loop-safe cancellation response and does not regress due to the new resume-event channel.

## Open Questions

None at the moment. The feature target is clear enough to draft and execute this plan.

## Outstanding Issues

Issues from the code review of the implemented changes (no CRITICAL/HIGH issues were found). Grouped by item.

### [Step 4 — Structured setup state / preset persistence]
- **MEDIUM (M1):** `detectPresetFromContent` (`apps/api/src/routes/chat.ts:382`) matches any `preset:xxx` token in free text, not just genuine quick-reply selections. A user message like "I don't want the preset:custom option" could persist a false `summary.preset` that misleads resumed reasoning. Whitelist against the known preset set (`trading`, `personal-assistant`, `custom`) and only persist on a genuine quick-reply selection.
- **MEDIUM (M2):** No direct unit test for `detectPresetFromContent` extraction/persistence. The existing test only verifies a preset already in metadata survives into the system prompt; it does not test that a `preset:personal-assistant` user message persists `summary.preset`, nor the negative free-text case. Add positive + negative unit tests.

### [Step 5 — Resume-aware fallback]
- **LOW (L1):** `buildResumeFallback` (`apps/api/src/routes/chat.ts:208`) renders the provider hint lowercase (e.g. "Your gmail connection is linked and ready."). Cosmetic but user-facing on the happy path; consider capitalizing the provider name or rephrasing to avoid the interpolated provider.

### [Step 1 — Resume-event channel]
- **LOW (L2):** `OnboardingResumeEvent.actionContext` is populated but never read. Either use it or drop it (KISS / avoid over-engineering).

### [Plan document]
- **LOW (L3):** Step status markers in this plan still read `PENDING`; update to reflect completion.

### [Tests]
- **LOW (L4):** Test assertions couple to exact prompt wording (e.g. `toContain('linked successfully during Guided Setup')`), which is brittle to prompt copy edits. Acceptable for this scope.
