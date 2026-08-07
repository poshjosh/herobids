# Plan: Chat LLM Usage Metering — Bill Users for Chat LLM Calls

**Feature:** Chat LLM usage metering (003)
**Date:** 2026-08-07
**Status:** Draft — Ready for Implementation

## Summary

Plan 003 (`docs/features/2026/08/06/003-guided-setup-billing-gate/001-plan.md`) implemented the billing **gate** for Guided Setup chat: users with no available credit are blocked from consuming paid LLM resources. It did **not** implement billing **metering** — recording LLM token usage as billable events when users do have credit.

Today, every `callLlmProvider()` call inside `invokeOnboardingLlm()` in `apps/api/src/routes/chat.ts` consumes paid LLM tokens without recording any usage event, ledger entry, or spend against the user's billing account.

This plan adds per-token billing metering for all chat surfaces: Guided Setup now, and future general Chat With AI surfaces through the same reusable path. This is consistent with ADR 005 (`docs/tech/adrs/2026/08/005-onboarding-chat-agent-runtime-model.md`): chat is billed per-token, not as continuous runtime.

## Current Code Truth

Confirmed from current code:

1. **Chat LLM calls are unmetered.** `invokeOnboardingLlm()` may call `callLlmProvider()` up to 6 times per user action (5 tool rounds + 1 final call). None of those calls record usage.

2. **The worker already has the correct billing shape.** In `apps/worker/src/agent.ts`, LLM usage is recorded through `UsageBillingService.recordLlmUsage(...)`, which ultimately calls `recordAndRateUsageBatch(...)`.

3. **The chat routes already resolve the billing account for the gate.** Both `POST /chat/threads/:id/messages` and `POST /chat/threads/:id/actions/:actionId` call `usageBillingRepo.getAccountByUserId(...)` and `canSpendNow(...)` before invoking the LLM.

4. **`invokeOnboardingLlm()` has multiple early return paths.** It returns early on provider failure, on the common "no tool calls" path, and on the final fallback path. Any aggregate billing design must survive all of those returns, not just the exhausted-tool-loop path.

5. **`billing_accounts` does NOT store included credit.** It stores `activePlanId`, `softCapMicrousd`, and `hardCapMicrousd`, but not `includedCreditMicrousd`. Included credit must come from plan config, not from the account row.

6. **Rating requires an active rate card id plus persisted rate-card items.** `recordAndRateUsageBatch(...)` rates against DB-backed `billing_rate_card_items`, which are populated via `ensureActiveRateCard(...)` and then loaded via `getRateCardItems(rateCardId)`. Constructor seed data alone is not enough.

7. **Fresh users may have no billing account yet.** The gate deliberately allows a user with no billing account / no open period to use chat. Metering must therefore be able to create the billing account lazily on first billable chat usage.

8. **Stable idempotency anchors already exist in the route handlers.** The message-send route creates `userMsgId` before the LLM call. The action-result route already has a stable `actionId` and an idempotency backstop in thread metadata.

9. **The worker bills the same LLM meter set we need for chat.** `llm.input_tokens`, `llm.cached_input_tokens`, `llm.output_tokens`, and `llm.reasoning_tokens` are recorded when available, with a `tokensUsed` → `llm.output_tokens` fallback when the provider only exposes totals.

10. **No explicit billing `enabled` flag is needed here.** The repo is already wired into the chat route. A separate toggle is unnecessary for this slice.

## Problem Statement

The chat flow currently:

- spends money on every LLM call,
- records none of that spend,
- and therefore under-reports usage while letting the platform absorb the cost.

The gate is correct, but metering is missing.

## Goal

Record billable chat LLM usage for every successful chat invocation, using the same billing primitives as worker LLM usage, while preserving the existing billing gate and current chat UX.

## Non-Goals

- Do not change the billing gate behavior.
- Do not change the conversation UX or tool loop behavior.
- Do not add billing to the plain create-agent form.
- Do not add runtime-style charges; chat remains per-message.
- Do not redesign the billing dashboard in this slice.

## Decisions (confirmed)

### D1. Recording granularity: one aggregate record set per user action

Accumulate usage across all `callLlmProvider()` calls for a single user action, then record one aggregate usage batch.

- Message send: one aggregate batch per persisted user message.
- Action result / resume: one aggregate batch per processed action id.

### D2. Rating approach: full rating via `recordAndRateUsageBatch`

Use the existing billing path that inserts events, rates them, applies ledger debits, updates the open period balance, and recomputes spend state atomically.

### D3. Billing aggregation happens inside `invokeOnboardingLlm()`, but billing writes happen in the route handlers

`invokeOnboardingLlm()` should only aggregate usage and return it. It should **not** write billing records itself.

Reason:

- it has multiple early return paths,
- it does not own the stable idempotency anchors,
- and the route handlers already own the request logger and persisted trigger ids.

### D4. Billing context resolution lives in an API-local recorder, not a repo-only helper

Create an API-local `ChatUsageBillingRecorder` (or equivalent helper/service) that has access to:

- `UsageBillingRepository`
- `plans` config
- `usageBilling.defaultRateCardName`

This avoids forcing repository methods to magically know plan config or rate-card config they do not currently own.

### D5. Idempotency anchors come from persisted trigger ids, not assistant message ids

Use route-owned stable anchors:

- message send: `userMsgId`
- action-result resume: `actionId`

Do **not** anchor billing idempotency on `assistantMsgId`, because that id is created later and is not available inside `invokeOnboardingLlm()`.

### D6. Meter set must match the worker

Record the same meter keys as the worker when data is available:

- `llm.input_tokens`
- `llm.cached_input_tokens`
- `llm.output_tokens`
- `llm.reasoning_tokens`

If granular token fields are unavailable but `tokensUsed > 0`, record a fallback `llm.output_tokens` event with `metadata: { granularity: 'total_only' }`.

### D7. Chat usage event shape is generic across chat surfaces

- `sourceType: 'chat_llm'`
- `sessionId: threadId`
- `agentId: null`
- `skillId: null`

This keeps the event shape reusable for future Chat With AI surfaces.

### D8. Error handling is fail-open

If billing recording fails after a successful LLM invocation, log a warning and still return the assistant response. Billing infrastructure errors must not block chat responses.

## Proposed Changes

### 1. Extend `LlmInvocationResult` with aggregate billing usage

**Location:** `apps/api/src/routes/chat.ts`

Add a billing usage payload to the return shape of `invokeOnboardingLlm()`:

```typescript
interface AggregateChatLlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  tokensUsed: number;
}

interface LlmInvocationResult {
  content: string;
  toolCallsProcessed: number;
  createdAgent?: { ... };
  summaryFacts?: { ... };
  actions?: ChatAction[];
  billingUsage?: AggregateChatLlmUsage;
}
```

### 2. Accumulate usage inside `invokeOnboardingLlm()` and return it on every path

**Location:** `apps/api/src/routes/chat.ts`

At the top of `invokeOnboardingLlm()`, initialize an accumulator:

```typescript
const usageAcc = {
  provider: llmConfig.provider,
  model: llmConfig.model,
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cachedInputTokens: 0,
  tokensUsed: 0,
};
```

On every successful `callLlmProvider(...)` result:

```typescript
usageAcc.provider = result.data.provider;
usageAcc.model = result.data.model;
usageAcc.inputTokens += result.data.inputTokens ?? 0;
usageAcc.outputTokens += result.data.outputTokens ?? 0;
usageAcc.thinkingTokens += result.data.thinkingTokens ?? 0;
usageAcc.cachedInputTokens += result.data.cachedInputTokens ?? 0;
usageAcc.tokensUsed += result.data.tokensUsed ?? 0;
```

Every return site in `invokeOnboardingLlm()` must include `billingUsage` when `usageAcc.tokensUsed > 0`, including:

- provider failure after earlier successful turns,
- the common "no tool calls" return,
- the exhausted-tool-loop final fallback return,
- the normal final success return.

`invokeOnboardingLlm()` does **not** call any billing repository methods.

### 3. Add an API-local `ChatUsageBillingRecorder`

**Location:** `apps/api/src/billing/chat-usage-billing-recorder.ts` (or equivalent API-local helper)

This recorder owns the billing-context resolution that the repository alone does not have.

Suggested shape:

```typescript
interface RecordChatLlmUsageInput {
  userId: string;
  threadId: string;
  billingAnchorId: string;
  phase: 'message_send' | 'action_result';
  usage: AggregateChatLlmUsage;
}

class ChatUsageBillingRecorder {
  constructor(
    private readonly repo: UsageBillingRepository,
    private readonly plans: PlansConfig,
    private readonly defaultRateCardName: string,
  ) {}

  async record(input: RecordChatLlmUsageInput): Promise<void> {
    // 1. Resolve current user plan id (repo.getUserPlanId(userId) ?? 'free')
    // 2. Resolve plan usage config from this.plans[planId]
    // 3. Convert cents → microusd for included credit and default caps
    // 4. getOrCreateBillingAccountForUser(userId, planId, { softCapMicrousd, hardCapMicrousd })
    // 5. ensureActiveRateCard(this.defaultRateCardName)
    // 6. getOrCreateOpenPeriod(account.id, now, account.activePlanId, rateCard.id, includedCreditMicrousd, account.softCapMicrousd, account.hardCapMicrousd)
    // 7. getRateCardItems(rateCard.id)
    // 8. Build InsertUsageEvent[]
    // 9. recordAndRateUsageBatch(events, period.id, account.id, rateCardItems)
    // 10. Return; caller handles logging on failure
  }
}
```

Important details:

- This must support **fresh users with no billing account yet** by creating the account lazily.
- Included credit comes from **plan config**, not the account row.
- The active rate card id comes from `ensureActiveRateCard(defaultRateCardName)`, not from constructor seed data.

### 4. Build idempotent chat usage events from stable trigger ids

**Location:** `apps/api/src/billing/chat-usage-billing-recorder.ts`

Build one usage event per non-zero meter key, using `billingAnchorId` to make retries safe:

```typescript
chat_llm_in_${phase}_${billingAnchorId}
chat_llm_cached_${phase}_${billingAnchorId}
chat_llm_out_${phase}_${billingAnchorId}
chat_llm_reason_${phase}_${billingAnchorId}
chat_llm_total_${phase}_${billingAnchorId}
```

Event shape:

- `sourceType: 'chat_llm'`
- `sessionId: threadId`
- `agentId: null`
- `skillId: null`
- `provider`, `model` from the aggregate usage

Meter mapping:

- non-cached prompt → `llm.input_tokens`
- cached prompt → `llm.cached_input_tokens`
- completion → `llm.output_tokens`
- reasoning/thinking → `llm.reasoning_tokens`
- total-only fallback → `llm.output_tokens` + `metadata: { granularity: 'total_only' }`

### 5. Record message-send billing in the message route

**Location:** `apps/api/src/routes/chat.ts`

In `POST /chat/threads/:id/messages`:

1. Keep the existing gate check unchanged.
2. Persist the user message and capture `userMsgId`.
3. Call `invokeOnboardingLlm(...)`.
4. If `llmResponse.billingUsage?.tokensUsed > 0`, call the recorder with:
   - `userId: request.userId`
   - `threadId: request.params.id`
   - `billingAnchorId: userMsgId`
   - `phase: 'message_send'`
5. Use `request.log.warn(...)` on failure; do not fail the request.

The recorder call is fire-and-forget:

```typescript
void chatUsageBillingRecorder.record({
  userId: request.userId,
  threadId: request.params.id,
  billingAnchorId: userMsgId,
  phase: 'message_send',
  usage: llmResponse.billingUsage,
}).catch((err) => {
  request.log.warn({ err, threadId: request.params.id, userMsgId }, 'Failed to record chat LLM usage');
});
```

### 6. Record action-result billing in the resume route

**Location:** `apps/api/src/routes/chat.ts`

In `POST /chat/threads/:id/actions/:actionId`:

1. Keep the existing action idempotency guard and billing gate unchanged.
2. Call `invokeOnboardingLlm(...)`.
3. If `llmResponse.billingUsage?.tokensUsed > 0`, call the recorder with:
   - `billingAnchorId: actionId`
   - `phase: 'action_result'`

This guarantees idempotent billing for repeated action-result submissions because the route already treats `actionId` as the stable processed-action identity.

### 7. Wire the recorder into route registration

**Location:** `apps/api/src/index.ts`, `apps/api/src/routes/chat.ts`

Construct the API-local recorder where chat routes are wired, alongside the existing `UsageBillingRepository`, and pass it into `chatRoutes(...)`.

The recorder needs:

- `new UsageBillingRepository(db, appConfig.usageBilling?.defaultRateCardItems, providersYaml)`
- `appConfig.plans`
- `appConfig.usageBilling?.defaultRateCardName ?? 'default'`

### 8. Update billing semantics docs

**Location:** `docs/tech/agents/billing-enforcement-semantics.md`

Document that chat metering:

- is per user action, not per individual tool round,
- uses `sourceType: 'chat_llm'`,
- reuses the same rate card and meter keys as worker LLM billing,
- and is anchored on persisted trigger ids (`userMsgId` / `actionId`) for idempotency.

## Implementation Order

1. [PENDING] Extend `LlmInvocationResult` with `billingUsage` and add accumulator logic inside `invokeOnboardingLlm()`.
2. [PENDING] Ensure every `invokeOnboardingLlm()` return path carries the aggregate usage when present.
3. [PENDING] Add `ChatUsageBillingRecorder` and its tests.
4. [PENDING] Wire the recorder into `chatRoutes(...)`.
5. [PENDING] Call the recorder from the message-send route using `userMsgId` as the anchor.
6. [PENDING] Call the recorder from the action-result route using `actionId` as the anchor.
7. [PENDING] Update billing semantics docs.
8. [PENDING] Add / update route tests.

## Verification

### Recorder tests (`apps/api/src/billing/chat-usage-billing-recorder.test.ts`)

1. Fresh user with no billing account gets a billing account created lazily and usage is recorded.
2. Included credit is resolved from plan config, not from the account row.
3. `ensureActiveRateCard(defaultRateCardName)` is called and DB-backed rate-card items are used for rating.
4. `recordAndRateUsageBatch(...)` is called with the expected meter keys and quantities.
5. `llm.reasoning_tokens` is recorded when `thinkingTokens > 0`.
6. `tokensUsed` falls back to a single `llm.output_tokens` event with `metadata.granularity = 'total_only'` when granular fields are unavailable.
7. Idempotency keys are derived from `phase + billingAnchorId` and prevent duplicate charges on retry.

### Route / integration tests (`apps/api/src/routes/chat.test.ts`)

8. Message-send route records one aggregate usage batch using `userMsgId` as the anchor.
9. Action-result route records one aggregate usage batch using `actionId` as the anchor.
10. The common "no tool calls" path still returns `billingUsage` and gets billed.
11. The exhausted-tool-loop final fallback path still returns `billingUsage` and gets billed.
12. Failed provider calls with no successful usage produce no billing record.
13. Billing recorder failures are logged and do not block the chat response.

### Documentation verification

14. The billing semantics doc matches the final implementation: per-action chat billing, `chat_llm` source type, worker-aligned meter keys, and persisted-trigger idempotency.

## Out of Scope

- Billing UI changes beyond the already existing totals.
- Splitting chat spend into a dedicated visible billing section.
- Changing the gate decision or top-up UX.
- General-purpose Chat With AI UI work; this plan only makes the billing path reusable for that future surface.

---

## Relationship to Other Plans

- **Plan 002** (`002-zero-balance-billing-enforcement`): implemented the shared `canSpendNow` guard for runtime billing. This plan makes chat spend flow into that same spend state correctly.
- **Plan 003** (`003-guided-setup-billing-gate`): implemented the gate for Guided Setup chat. This plan adds the missing metering side.
- **ADR 005** (`005-onboarding-chat-agent-runtime-model`): states that chat is billed per-token rather than as continuous runtime. This plan implements that statement.
