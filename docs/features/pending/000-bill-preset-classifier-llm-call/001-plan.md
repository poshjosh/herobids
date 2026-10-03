# Plan: Bill the guided-chat preset classifier LLM call

Status: pending
Owner: (unassigned)
Related: feature 009 (`docs/features/2026/10/02/004-skill-first-agent-creation/001-plan.md`),
commit 35f28eab introduced `classifyPreset` in `apps/api/src/routes/chat.ts`.

## Problem

Feature 009 added `classifyPreset` (`apps/api/src/routes/chat.ts`): a
temperature-0 LLM call made once per guided-setup thread that maps the user's
first message to a prompt preset (`trading` / `personal-assistant` / `custom`).

That call is **not metered**. `classifyPreset` invokes `callLlmProvider`
directly and returns only the mapped preset token — it discards the usage from
`result.data` (`tokensUsed`, `inputTokens`, `outputTokens`, `thinkingTokens`,
`cachedInputTokens`). The billing path (`chatUsageBillingRecorder.record(...)`,
~line 2300 for `message_send`) only records `llmResponse.billingUsage`, which
comes from `invokeOnboardingLlm`'s internal `usageAcc`. The classifier runs
*outside* `invokeOnboardingLlm` (just before it, in the `/messages` route), so
its tokens never reach the recorder.

The code comment on `classifyPreset` currently documents this as intentional
("negligible and intentionally not folded into the chat usage recorder"). This
plan reverses that decision: the tokens, however small, are real provider spend
and should be attributed to the user like every other chat LLM call.

## Goal

Record the preset classifier's LLM usage through the existing
`ChatUsageBillingRecorder`, attributed to the same user and thread, with its own
idempotency scope so it never collides with the `message_send` turn that runs
immediately after it.

Non-goals:
- No change to classifier behavior (still sticky, once-per-thread, temp 0,
  defaults to `custom` on failure, skips button-reply values).
- No change to the rate card, meter keys, or the recorder's rating/period logic.
- No new billing concepts — reuse the existing `chat_llm` source type and
  `llm.*_tokens` meter keys.

## Key facts established during investigation

1. **The classifier discards usage.** `classifyPreset(llmConfig, firstUserMessage)`
   returns `Promise<'trading' | 'personal-assistant' | 'custom'>`. On
   `result.ok` it reads only `result.data.content`; the usage fields on
   `result.data` are dropped. (`apps/api/src/routes/chat.ts`, `classifyPreset`.)

2. **`callLlmProvider` already reports the usage we need.** Its success data
   (`packages/llm/src/llm-provider.ts`, the `LlmProviderResult`-style shape)
   carries `tokensUsed`, and optionally `inputTokens`, `outputTokens`,
   `thinkingTokens`, `cachedInputTokens`, plus `provider` and `model`. These map
   1:1 onto `AggregateChatLlmUsage`.

3. **The recorder's input contract.** `ChatUsageBillingRecorder.record(input)`
   (`apps/api/src/billing/chat-usage-billing-recorder.ts`) takes
   `RecordChatLlmUsageInput`:
   - `userId`, `threadId`, `billingAnchorId`, `phase`, `usage`.
   - `phase` is currently the union `'message_send' | 'action_result'`.
   - `usage` is `AggregateChatLlmUsage` (`provider`, `model`, `inputTokens`,
     `outputTokens`, `thinkingTokens`, `cachedInputTokens`, `tokensUsed`).
   - It early-returns when `usage.tokensUsed <= 0`.
   - It builds idempotent events keyed by `idScope = \`${phase}_${billingAnchorId}\``
     and per-meter idempotency keys (`chat_llm_in_…`, `chat_llm_out_…`, etc.).
     So uniqueness across calls depends on `phase` + `billingAnchorId`.

4. **The call site.** In the `/messages` route (`apps/api/src/routes/chat.ts`,
   ~line 2268), the classifier runs inside
   `if (!effectiveMetadata?.summary?.preset && !BUTTON_VALUE_RE.test(trimmedContent))`,
   wrapped in try/catch, before `invokeOnboardingLlm`. The `message_send`
   recorder call that follows uses `billingAnchorId: userMsgId` and
   `phase: 'message_send'`. The classifier must NOT reuse that exact
   `(phase, billingAnchorId)` pair or its events would collide / be deduped
   against the main turn's events.

5. **Recorder availability.** `chatUsageBillingRecorder` is an optional
   constructor-injected dependency of `chatRoutes` (may be `undefined` in tests).
   The existing recorder calls are all guarded by
   `if (chatUsageBillingRecorder && billingUsage && billingUsage.tokensUsed > 0)`
   and fired as `void …​.catch(…)` (fire-and-forget, never blocking the turn).

## Design

The classifier must still never block or fail the conversation, and billing
must stay fire-and-forget. Two sub-decisions:

### D1 — Where to surface the usage: return it from `classifyPreset`

Change `classifyPreset` to return the mapped preset **and** the usage it
consumed, so the route can record it. Preferred shape:

```ts
interface PresetClassification {
  preset: 'trading' | 'personal-assistant' | 'custom';
  usage?: AggregateChatLlmUsage; // undefined when the call failed / no usage
}
async function classifyPreset(
  llmConfig: LlmConfig,
  firstUserMessage: string,
): Promise<PresetClassification>
```

- On `result.ok`, build `usage` from `result.data` (provider, model, the four
  token fields defaulting to 0, `tokensUsed`).
- On `!result.ok`, return `{ preset: 'custom', usage: undefined }`.
- Keep the mapping logic identical.

Rationale: keeps the LLM-usage extraction next to the call that produced it, and
keeps the route in charge of billing (consistent with how `invokeOnboardingLlm`
returns `billingUsage` and the route records it). Alternative — passing the
recorder into `classifyPreset` — was rejected: it couples a pure classifier to
the billing dependency and spreads fire-and-forget error handling into a helper.

### D2 — Idempotency scope: a distinct phase

Add a third `phase` value, `'preset_classify'`, to
`RecordChatLlmUsageInput['phase']`. Record the classifier usage with
`phase: 'preset_classify'` and `billingAnchorId: userMsgId` (the same anchor
message is fine because `phase` now differentiates the idScope, giving
idempotency keys like `chat_llm_in_preset_classify_<userMsgId>` distinct from
`chat_llm_in_message_send_<userMsgId>`).

Rationale: reusing `'message_send'` with the same `userMsgId` would make the
classifier's per-meter idempotency keys identical to the main turn's, so one
set would be silently deduped and under-bill. A distinct phase is the minimal,
explicit fix and also makes the classifier spend separable in reporting.

Confirm at implementation time whether any analytics / rate-card logic switches
on `phase` (grep for `'message_send'` / `'action_result'` usages); if a rate
card or report enumerates phases, extend it to include `'preset_classify'`.

## Files to change

1. `apps/api/src/routes/chat.ts`
   - `classifyPreset`: change the return type to `PresetClassification` (preset +
     optional `usage`); build `usage` from the `callLlmProvider` success data.
     Update the doc comment — remove the "intentionally not folded into the chat
     usage recorder" note and replace it with a note that usage is returned for
     the caller to meter.
   - Classifier call site (~line 2268): destructure `{ preset, usage }`; set
     `classifiedPreset = preset`; after writing the preset to `effectiveMetadata`,
     fire a guarded, fire-and-forget recorder call:
     ```ts
     if (chatUsageBillingRecorder && usage && usage.tokensUsed > 0) {
       void chatUsageBillingRecorder.record({
         userId: request.userId,
         threadId: request.params.id,
         billingAnchorId: userMsgId,
         phase: 'preset_classify',
         usage,
       }).catch((err) => request.log.warn(
         { err, threadId: request.params.id, userMsgId },
         'Failed to record preset-classifier LLM usage',
       ));
     }
     ```
     Keep the try/catch around `classifyPreset` so a classifier throw still
     defaults to `custom`; on throw there is simply no usage to record.

2. `apps/api/src/billing/chat-usage-billing-recorder.ts`
   - Extend `RecordChatLlmUsageInput['phase']` to
     `'message_send' | 'action_result' | 'preset_classify'`. No other change —
     `buildIdempotentEvents` already derives `idScope` from `phase`, so the new
     phase gets unique idempotency keys automatically.

## Tests

- `apps/api/src/routes/chat.test.ts`
  - `classifyPreset` now returns `{ preset, usage }`: assert `usage` is populated
    (provider/model/token fields) on a successful classification and `undefined`
    on provider error. Update existing `classifyPreset` unit assertions to the
    new return shape.
  - Route test (mock recorder, as `makeMockRecorder()` already provides): on a
    first user message that triggers classification, the recorder is called with
    `phase: 'preset_classify'`, `billingAnchorId: userMsgId`, and the classifier
    usage — in addition to the existing `message_send` call. Assert both calls
    happen and carry distinct `phase` values.
  - Sticky path: when `preset` is already set (classifier skipped), no
    `preset_classify` recorder call is made.
  - Failure path: classifier throws → preset defaults to `custom`, no
    `preset_classify` recorder call, turn still responds 200 (existing test
    extended).
  - Zero-usage guard: `usage.tokensUsed === 0` → no `preset_classify` call.
- `apps/api/src/billing/chat-usage-billing-recorder.test.ts`
  - Add a case recording with `phase: 'preset_classify'` and assert the
    generated idempotency keys are scoped by that phase (e.g.
    `chat_llm_in_preset_classify_<anchor>`), distinct from a `message_send`
    recording with the same anchor.

## Verification (Definition of Done)

1. `pnpm lint` green.
2. `pnpm --filter @herobids/api exec vitest run src/routes/chat.test.ts` green.
3. `pnpm --filter @herobids/api exec vitest run src/billing/chat-usage-billing-recorder.test.ts` green.
4. Full API vitest green.
5. Manual/trace check (optional): a fresh guided-setup thread's first message
   produces TWO `chat_llm` usage records for that `userMsgId` — one
   `preset_classify`, one `message_send` — with non-colliding idempotency keys.

## Open items to confirm at implementation time

- Grep `'message_send'` / `'action_result'` across `apps/api` and any billing
  reporting/analytics to confirm nothing enumerates `phase` exhaustively; if so,
  add `'preset_classify'` there too.
- Confirm `callLlmProvider`'s success data exposes `provider`/`model` at the
  classifier call (it does for both OpenAI and Anthropic paths per
  `packages/llm/src/llm-provider.ts`); default any absent token field to 0 when
  constructing `AggregateChatLlmUsage`.
- Decide whether `preset_classify` should be visible as a separate line in any
  user-facing usage breakdown or folded into the chat total (default: separate,
  since the recorder already stores `sourceType: 'chat_llm'` for both — the
  phase is only in the idempotency key, not a stored dimension, so no UI change
  is required unless a breakdown reads the idempotency scope).

## Risks

- **Idempotency collision (addressed by D2).** Reusing `message_send` +
  `userMsgId` would silently dedupe/under-bill. The distinct `preset_classify`
  phase prevents this; the recorder test locks it in.
- **Billing must stay non-blocking.** The recorder call is fire-and-forget
  (`void … .catch`), identical to the existing calls; a billing failure must
  never fail agent creation or the chat turn.
- **Behavioral drift.** Changing `classifyPreset`'s return type touches its unit
  tests; the mapping and sticky/skip/failure semantics must remain byte-for-byte
  the same — only the returned shape (adding `usage`) changes.
