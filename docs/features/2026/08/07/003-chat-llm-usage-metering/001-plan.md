# Plan: Chat LLM Usage Metering — Bill Users for Guided Setup LLM Calls

**Feature:** Chat LLM usage metering (003)
**Date:** 2026-08-07
**Status:** Draft — Ready for Implementation

## Summary

Plan 003 (`docs/features/2026/08/06/003-guided-setup-billing-gate/001-plan.md`) successfully implemented a billing **gate** for the Guided Setup chat: users with no available credit are blocked from consuming paid LLM resources. However, it did NOT implement billing **metering** — recording LLM token usage as billable events when users DO have credit.

This means the platform currently absorbs all LLM costs for Guided Setup chat usage. Every `callLlmProvider()` call in `invokeOnboardingLlm()` in `apps/api/src/routes/chat.ts` consumes paid LLM tokens without recording any usage event, ledger entry, or cost against the user's billing account.

This plan adds per-token billing metering to all chat surfaces (Guided Setup today, general Chat With AI in the future), consistent with ADR 005 (`docs/tech/adrs/2026/08/005-onboarding-chat-agent-runtime-model.md`) which states: **"It is billed per-token like other Chat With AI usage. No hourly/daily runtime cost."**

## Current Code Truth

Confirmed from current code:

1. **Chat LLM calls are unmetered.** `invokeOnboardingLlm()` calls `callLlmProvider()` 1–6 times per message (up to 5 tool-calling rounds + 1 final call). None of these calls record usage events.

2. **The worker DOES meter LLM usage.** In `apps/worker/src/agent.ts`, every scout, judge, and hybrid LLM call records usage via `usageBillingService.recordLlmUsage(...)` which calls `repo.recordAndRateUsageBatch(...)` — inserting usage events, rating them against the rate card, applying ledger debits, and recomputing spend state atomically.

3. **`usageBillingRepo` is already wired into the chat route.** `apps/api/src/index.ts:260-261` constructs `chatUsageBillingRepo = new UsageBillingRepository(db, ...)` and passes it to `chatRoutes(...)`. The route uses it for the gate check (`canSpendNow`, `getAccountByUserId`) but not for recording usage.

4. **`callLlmProvider` returns structured usage data.** The `LlmResult.data` shape includes:
   ```typescript
   {
     responseId: string;
     provider: string;
     model: string;
     tokensUsed: number;
     inputTokens?: number;
     outputTokens?: number;
     thinkingTokens?: number;
     cachedInputTokens?: number;
   }
   ```
   This is exactly the data needed to construct `LlmUsageInput` for the worker's `recordLlmUsage` pattern.

5. **Only `recordAndRateUsageBatch` produces billable costs.** `recordUsageEvents(...)` inserts raw events but does NOT rate them, create ledger entries, update period balance, or recompute spend status. There is no background reconciler for unrated events — raw events would sit in the DB indefinitely with zero effect on billing. The worker uses `recordAndRateUsageBatch` exclusively. This plan must use it too.

6. **`UsageBillingRepository` already has `getOrCreateOpenPeriod(...)`** which creates/returns an open billing period. It requires plan-level parameters (`planIdSnapshot`, `rateCardId`, `includedCreditMicrousd`, `softCapMicrousd`, `hardCapMicrousd`). These are available from the `billingAccounts` row — the account already stores `activePlanId`, `softCapMicrousd`, `hardCapMicrousd`, and `includedCreditMicrousd`.

7. **No billing `enabled` flag needed for the chat.** The repo is always constructed and the gate already runs. An explicit toggle would be redundant. The `usageBillingRepo` parameter being present is sufficient signal that billing is active.

## Problem Statement

The Guided Setup chat currently:

- Calls `callLlmProvider()` 1–6 times per user message
- Returns token usage data from each call
- Does NOT record any billing events for the tokens consumed

This means:
- The platform subsidizes all Guided Setup LLM costs
- User billing dashboards show no chat-related spend
- The `canSpendNow` gate works correctly (blocks when no credit), but users who pass the gate consume resources for free

## Goal

Record LLM token usage as billable events for every Guided Setup chat LLM call, consistent with the worker's agent runtime billing pattern.

## Non-Goals

- Do not change the billing gate behavior (blocking when no credit)
- Do not change the chat UX or LLM invocation flow
- Do not add billing for the plain create-agent form (no LLM calls)
- Do not add runtime billing (the chat is per-message, not continuous)
- Do not change the rate card or pricing model

## Decisions (confirmed)

### D1. Recording granularity: per-message aggregate

**Confirmed: Aggregate.** Accumulate token counts across all `callLlmProvider()` calls in `invokeOnboardingLlm()` (up to 5 tool-loop rounds + 1 final call) and record a single batch at the end. The chat is a single user action → single billing event. Per-turn attribution is not useful for chat (unlike agent ticks where scout vs judge cost matters). One DB transaction per message instead of up to 6.

### D2. Rating approach: full rating via `recordAndRateUsageBatch`

**Confirmed: Full rating.** `recordUsageEvents` (raw events) is not viable — it inserts rows that are never rated, never create ledger entries, never update period balance, and never affect spend status. There is no background reconciler. The worker exclusively uses `recordAndRateUsageBatch`; the chat must do the same.

### D3. Account/period resolution: repo method reads from `billingAccounts` row

**Confirmed: Read from account row.** Add a `recordChatLlmUsage(accountId, userId, threadId, usage)` convenience method to `UsageBillingRepository` that:
1. Reads the billing account row to get `activePlanId`, `softCapMicrousd`, `hardCapMicrousd`, `includedCreditMicrousd`
2. Gets or creates the open period via `getOrCreateOpenPeriod(...)`
3. Gets rate card items from `this.rateCardItems` (constructor-provided)
4. Builds `InsertUsageEvent[]` from the aggregate token counts
5. Calls `recordAndRateUsageBatch(events, periodId, accountId, rateCardItems)`

No plan config needs to be threaded from the API layer — the account row already stores everything needed.

### D4. Session/agent context: `threadId` → `sessionId`, `sourceType: 'chat_llm'`

**Confirmed.** Use `threadId` in the `sessionId` field for useful grouping in billing queries. Set `sourceType: 'chat_llm'` (generic, works for Guided Setup and future Chat With AI). `agentId` and `skillId` are `null` — chat is not agent-scoped.

### D5. Error handling: fail-open (fire-and-forget)

**Confirmed: Fail-open.** Consistent with the worker's `void this.doRecordLlmUsage(input).catch(...)`. Billing recording failures must not block the chat response. The gate already confirmed the user can spend.

### D6. No explicit `enabled` toggle needed

**Confirmed: No toggle.** The `usageBillingRepo` parameter being present is sufficient signal. The worker's `enabled` flag exists because `UsageBillingService` is a long-lived singleton that may be reconfigured; the chat's per-request model doesn't need this.

## Proposed Changes

### 1. Add `recordChatLlmUsage` convenience method to `UsageBillingRepository`

**Location:** `packages/db/src/usage-billing-repository.ts`

Add a method that encapsulates the full chat LLM usage recording flow. It receives aggregate token counts (summed across all tool-loop calls for one message) and handles period creation, rate card lookup, event construction, and rating internally:

```typescript
export interface ChatLlmUsageInput {
  accountId: string;
  userId: string;
  threadId: string;
  /** Aggregate input tokens across all LLM calls in this message (non-cached). */
  inputTokens: number;
  /** Aggregate output tokens across all LLM calls in this message. */
  outputTokens: number;
  /** Aggregate thinking/reasoning tokens. */
  thinkingTokens: number;
  /** Aggregate cached input tokens (billed at lower rate). */
  cachedInputTokens: number;
  /** Provider used (from the first call; all calls in a message use the same provider). */
  provider: string;
  /** Model used (from the first call). */
  model: string;
}

async recordChatLlmUsage(input: ChatLlmUsageInput): Promise<void> {
  // 1. Read billing account row to get plan context
  //    SELECT activePlanId, softCapMicrousd, hardCapMicrousd, includedCreditMicrousd
  //    FROM billingAccounts WHERE id = input.accountId
  //    If no account → return (no-op)
  //
  // 2. Get or create open period
  //    const period = await this.getOrCreateOpenPeriod(
  //      accountId, new Date(), account.activePlanId,
  //      rateCardId, account.includedCreditMicrousd,
  //      account.softCapMicrousd, account.hardCapMicrousd,
  //    );
  //
  // 3. Get rate card items from this.rateCardItems
  //
  // 4. Build InsertUsageEvent[] (same pattern as worker's doRecordLlmUsage):
  //    - llm.input_tokens  (meterKey) for input.inputTokens
  //    - llm.output_tokens (meterKey) for input.outputTokens
  //    - llm.cached_input_tokens (meterKey) for input.cachedInputTokens
  //    - sourceType: 'chat_llm'
  //    - sessionId: input.threadId
  //    - agentId: null, skillId: null
  //    - idempotencyKey: `chat_llm_${threadId}_${messageId}`
  //
  // 5. Call recordAndRateUsageBatch(events, period.id, accountId, rateCardItems)
}
```

Plan context (included credit, caps, planId) is read from the `billingAccounts` row — the account already stores these values. No plan config needs to be threaded from the API layer.

### 2. Thread `accountId` and `threadId` through `invokeOnboardingLlm()`

**Location:** `apps/api/src/routes/chat.ts`

`invokeOnboardingLlm()` currently receives `userId` and `usageBillingRepo` but not `accountId` or `threadId`. The route handlers already resolve `accountId` for the gate check — thread it through to avoid a second DB query.

Add `accountId?: string` and `threadId: string` parameters to `invokeOnboardingLlm()`.

### 3. Accumulate and record usage once per message

**Location:** `apps/api/src/routes/chat.ts` — `invokeOnboardingLlm()`

Accumulate token counts across all `callLlmProvider()` calls in the tool-calling loop (up to 5 rounds + 1 final call), then record a single aggregate batch after the loop completes — before returning the response. This produces one DB transaction per message instead of up to 6.

```typescript
// At the top of invokeOnboardingLlm():
const usageAcc = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedInputTokens: 0 };
let provider = '';
let model = '';

// In the tool loop, after each successful callLlmProvider():
if (result.ok) {
  usageAcc.inputTokens += result.data.inputTokens ?? 0;
  usageAcc.outputTokens += result.data.outputTokens ?? 0;
  usageAcc.thinkingTokens += result.data.thinkingTokens ?? 0;
  usageAcc.cachedInputTokens += result.data.cachedInputTokens ?? 0;
  if (!provider) provider = result.data.provider;
  if (!model) model = result.data.model;
}

// After the loop, before returning the response:
const totalTokens = usageAcc.inputTokens + usageAcc.outputTokens;
if (usageBillingRepo && accountId && totalTokens > 0) {
  void usageBillingRepo.recordChatLlmUsage({
    accountId,
    userId,
    threadId,
    provider,
    model,
    ...usageAcc,
  }).catch((err) => {
    // Log but don't block — fail-open (D5)
    console.warn({ err, threadId }, 'Failed to record chat LLM usage');
  });
}
```

Fire-and-forget (don't await) — consistent with the worker pattern. The chat response is not delayed by billing recording.

### 4. Update billing enforcement semantics documentation

**Location:** `docs/tech/agents/billing-enforcement-semantics.md`

Add a section documenting that Guided Setup chat LLM usage is metered per-message (not per-call), using the same rate card as agent runtime LLM usage. Document the `sourceType: 'chat_llm'` usage event type and the `sessionId: threadId` mapping.

### 5. Tests

**Repository tests** (`packages/db/src/usage-billing-repository.test.ts`):
- `recordChatLlmUsage` inserts usage events with correct meter keys
- `recordChatLlmUsage` rates events and updates period balance
- `recordChatLlmUsage` handles missing account/period gracefully
- `recordChatLlmUsage` is idempotent (same idempotency key → no duplicate charge)

**API tests** (`apps/api/src/routes/chat.test.ts`):
- Successful chat message records usage via `usageBillingRepo`
- Failed LLM call does NOT record usage
- Chat response is delivered even if usage recording fails (fail-open)
- Aggregate recording accumulates across tool-calling rounds

### 6. Expose chat usage in billing UI (optional, future slice)

Once usage events are recorded with `sourceType: 'chat_llm'`, the billing dashboard can filter/display chat costs separately from agent runtime costs. This is a frontend-only change and out of scope for this plan.

## Implementation Order

1. Add `recordChatLlmUsage` method to `UsageBillingRepository` (+ unit tests: items 1–5 below)
2. Thread `accountId` and `threadId` through `invokeOnboardingLlm()`
3. Add aggregate usage accumulation + fire-and-forget recording in `invokeOnboardingLlm()`
4. Update `docs/tech/agents/billing-enforcement-semantics.md`
5. API tests for recording behavior (items 6–10 below)

## Verification

### Repository tests (`packages/db/src/usage-billing-repository.test.ts`)

1. `recordChatLlmUsage` creates `llm.input_tokens`, `llm.output_tokens`, `llm.cached_input_tokens` events with `sourceType: 'chat_llm'` and `sessionId` set to `threadId`
2. Events are rated against the rate card and debited from the period balance
3. Idempotency key prevents duplicate charges on retry
4. Missing account → no-op (no crash)
5. No open period → period is created from account row defaults, then events recorded

### API tests (`apps/api/src/routes/chat.test.ts`)

6. Sending a message that results in LLM calls records a single aggregate usage batch via `usageBillingRepo`
7. Aggregate token counts match the sum of individual `callLlmProvider` results across all tool-loop rounds
8. When `usageBillingRepo` is not provided, no crash and chat proceeds normally
9. When usage recording throws, chat response is still delivered (fail-open)
10. Failed LLM calls (provider error) do NOT contribute to the aggregate

---

## Relationship to Other Plans

- **Plan 002** (`002-zero-balance-billing-enforcement`): Implemented the `canSpendNow` guard for agent runtime. This plan's metering makes the gate more accurate — chat spend is reflected immediately in available credit.
- **Plan 003** (`003-guided-setup-billing-gate`): Implemented the billing gate for Guided Setup chat. This plan adds the metering side — together they form the complete "wire chat to user costs" picture.
- **ADR 005** (`005-onboarding-chat-agent-runtime-model`): Declares chat is billed per-token. This plan implements that declaration.
