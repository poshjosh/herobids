# Plan: Chat LLM Usage Metering — Bill Users for Guided Setup LLM Calls

**Feature:** Chat LLM usage metering (003)
**Date:** 2026-08-07
**Status:** Draft — Pending Clarification

## Summary

Plan 003 (`docs/features/2026/08/06/003-guided-setup-billing-gate/001-plan.md`) successfully implemented a billing **gate** for the Guided Setup chat: users with no available credit are blocked from consuming paid LLM resources. However, it did NOT implement billing **metering** — recording LLM token usage as billable events when users DO have credit.

This means the platform currently absorbs all LLM costs for Guided Setup chat usage. Every `callLlmProvider()` call in `invokeOnboardingLlm()` in `apps/api/src/routes/chat.ts` consumes paid LLM tokens without recording any usage event, ledger entry, or cost against the user's billing account.

This plan adds per-token billing metering to the Guided Setup chat, consistent with ADR 005 (`docs/tech/adrs/2026/08/005-onboarding-chat-agent-runtime-model.md`) which states: **"It is billed per-token like other Chat With AI usage. No hourly/daily runtime cost."**

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

5. **The repo supports two usage-recording paths:**
   - `recordUsageEvents(events)` — insert raw events (idempotent), does NOT rate them
   - `recordAndRateUsageBatch(events, periodId, accountId, rateCardItems)` — insert, rate, apply ledger, recompute spend — all in one transaction

6. **`UsageBillingRepository` already has `getOrCreateOpenPeriod(...)`** which creates/returns an open billing period. But it requires plan-level parameters (`planIdSnapshot`, `rateCardId`, `includedCreditMicrousd`, `softCapMicrousd`, `hardCapMicrousd`) that the chat route doesn't currently have access to.

7. **The API's `appConfig` has plan information.** `appConfig.plans` contains plan definitions with `usage.includedCreditCents`, `usage.softCapCents`, `usage.hardCapCents`. `appConfig.usageBilling` has billing configuration. These are available at route registration time but would need to be threaded through to the per-request handler.

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

## Key Design Decisions (to be confirmed)

### D1. Recording granularity: per-call vs per-message aggregate

**Option A (per-call):** Record usage after each `callLlmProvider()` call in the tool loop. This gives fine-grained billing but creates 1–6 usage records per message.

**Option B (per-message aggregate):** Accumulate token counts across all calls in `invokeOnboardingLlm()` and record a single batch at the end. Simpler but loses per-turn attribution.

**Recommendation: Option B** for the first slice. The chat is a single user action → single billing event. Per-turn attribution is not useful for chat (unlike agent ticks where scout vs judge cost matters). Aggregate recording also means only one DB transaction per message instead of up to 6.

### D2. Rating approach: full (rate + ledger) vs raw events only

**Option A (full rating):** Use `recordAndRateUsageBatch(...)` — rate events against the rate card, apply ledger debits, recompute spend state. This immediately reflects costs in the user's billing dashboard and the `canSpendNow` gate.

**Option B (raw events):** Use `recordUsageEvents(...)` — insert raw events only. Costs are picked up by the next period reconciliation. Simpler but costs don't appear immediately.

**Recommendation: Option A** for correctness. Users should see their chat costs reflected immediately, and the `canSpendNow` gate should account for recent chat spend. However, Option B is acceptable as a first slice if Option A requires too much plumbing (period/rateCard resolution).

### D3. Account/period resolution

The chat route already resolves the billing account for the gate check. To record usage with rating, we also need:
- An open billing period (`periodId`)
- Rate card items
- Plan-level parameters (included credit, caps)

**Options:**
- (a) Resolve everything in the route handler, pass to a recording helper
- (b) Add a convenience method to `UsageBillingRepository` that encapsulates the full flow: `recordChatLlmUsage(accountId, userId, llmUsageData)`
- (c) Create a lightweight `ChatBillingService` that wraps the repo with plan config

**Recommendation: (b)** — a single repo method that takes the user/account context and LLM usage data, and handles period creation, rate card lookup, event construction, and recording. This keeps the chat route simple and follows the existing pattern of keeping billing logic in the repo.

### D4. Session/agent context for usage events

The worker's usage events include `agentId`, `sessionId`, and `skillId`. The chat has none of these — it's a per-message LLM call, not an agent runtime.

**Options:**
- (a) Leave `agentId`, `sessionId`, `skillId` as `null` — chat is not agent-scoped
- (b) Use the chat `threadId` as a `sessionId`-like identifier
- (c) Create a synthetic "chat agent" identity

**Recommendation: (b).** Use `threadId` in the `sessionId` field and set `sourceType: 'chat_llm'`. This gives useful grouping in billing queries without inventing fake agent identities.

### D5. Error handling: fail-open or fail-closed

If the billing recording fails (DB error, network issue), should the chat response still be delivered?

**Option A (fail-open):** Log the error, deliver the chat response. The user gets their agent created; billing catches up later.

**Option B (fail-closed):** Return an error to the user. No free LLM consumption.

**Recommendation: Option A.** Consistent with the worker's fire-and-forget pattern (`void this.doRecordLlmUsage(input).catch(...)`). Billing infra issues should not block the user from creating an agent they have credit for. The gate already confirmed they can spend.

## Proposed Changes

### 1. Add `recordChatLlmUsage` convenience method to `UsageBillingRepository`

**Location:** `packages/db/src/usage-billing-repository.ts`

Add a method that encapsulates the full chat LLM usage recording flow:

```typescript
export interface ChatLlmUsageInput {
  accountId: string;
  userId: string;
  threadId: string;
  provider: string;
  model: string;
  responseId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cachedInputTokens?: number | null;
  tokensUsed?: number;
  phase: string; // 'chat_message' | 'chat_action_result'
  turnIndex?: number;
}

async recordChatLlmUsage(input: ChatLlmUsageInput): Promise<void> {
  // 1. Get or create open period for the account
  //    - Resolve user's planId from users table
  //    - Get plan defaults (included credit, caps) from ??? (see D6)
  //    - Get or create open period via getOrCreateOpenPeriod(...)
  //
  // 2. Get rate card items
  //    - Use this.rateCardItems (constructor-provided defaults)
  //
  // 3. Build InsertUsageEvent[] from input (same pattern as worker's doRecordLlmUsage)
  //    - llm.input_tokens, llm.output_tokens, llm.cached_input_tokens
  //    - sourceType: 'chat_llm', sessionId: input.threadId
  //
  // 4. Call recordAndRateUsageBatch(events, periodId, accountId, rateCardItems)
}
```

> **Open question (D6):** Where does plan config come from? The repo doesn't have access to plan definitions. Options:
> - (a) Pass plan defaults as constructor args to `UsageBillingRepository` (already partially done — `rateCardItems` are passed)
> - (b) Accept plan defaults as parameters to `recordChatLlmUsage`
> - (c) The repo queries the `billingAccounts` table for the account's current caps/planId (they're already stored there)
>
> **Recommendation: (c).** The `billingAccounts` row already stores `activePlanId`, `softCapMicrousd`, `hardCapMicrousd`, and `includedCreditMicrousd`. The `getOrCreateOpenPeriod` method already reads these. The repo method can read the account row to get plan context.

### 2. Record usage after each chat LLM invocation

**Location:** `apps/api/src/routes/chat.ts` — `invokeOnboardingLlm()`

After each successful `callLlmProvider()` call (in the tool loop and the final call), record usage:

```typescript
// After a successful callLlmProvider() in invokeOnboardingLlm():
if (result.ok && usageBillingRepo && accountId) {
  void usageBillingRepo.recordChatLlmUsage({
    accountId,
    userId,
    threadId: threadMetadata?.threadId, // need to thread through
    provider: result.data.provider,
    model: result.data.model,
    responseId: result.data.responseId,
    inputTokens: result.data.inputTokens,
    outputTokens: result.data.outputTokens,
    thinkingTokens: result.data.thinkingTokens,
    cachedInputTokens: result.data.cachedInputTokens,
    tokensUsed: result.data.tokensUsed,
    phase: 'chat_message',
    turnIndex: round,
  }).catch((err) => {
    request.log?.warn?.({ err }, 'Failed to record chat LLM usage');
  });
}
```

Fire-and-forget (don't await) — consistent with the worker pattern. The chat response is not delayed by billing recording.

### 3. Thread `accountId` and `threadId` through `invokeOnboardingLlm()`

**Location:** `apps/api/src/routes/chat.ts`

`invokeOnboardingLlm()` currently receives `userId` and `usageBillingRepo` but not `accountId` or `threadId`. The route handlers already resolve `accountId` for the gate check — thread it through to avoid a second DB query.

Add `accountId?: string` and `threadId: string` parameters to `invokeOnboardingLlm()`.

### 4. Aggregate recording (if D1 Option B is chosen)

Instead of recording after each individual LLM call, accumulate token counts in a local accumulator and record once after `invokeOnboardingLlm()` completes (before returning the response). This reduces DB writes from up to 6 per message to 1.

```typescript
const llmUsageAccumulator = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedInputTokens: 0, tokensUsed: 0 };

// In the tool loop, after each successful call:
llmUsageAccumulator.inputTokens += result.data.inputTokens ?? 0;
llmUsageAccumulator.outputTokens += result.data.outputTokens ?? 0;
// ... etc.

// After the loop (before return):
if (usageBillingRepo && accountId && totalTokens > 0) {
  void usageBillingRepo.recordChatLlmUsage({ ...llmUsageAccumulator, phase: 'chat_message' }).catch(...);
}
```

### 5. Update billing enforcement semantics documentation

**Location:** `docs/tech/agents/billing-enforcement-semantics.md`

Add a section documenting that Guided Setup chat LLM usage is metered per-message (not per-call), using the same rate card as agent runtime LLM usage. Document the `sourceType: 'chat_llm'` usage event type and the `sessionId: threadId` mapping.

### 6. Tests

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

### 7. Expose chat usage in billing UI (optional, future slice)

Once usage events are recorded with `sourceType: 'chat_llm'`, the billing dashboard can filter/display chat costs separately from agent runtime costs. This is a frontend-only change and out of scope for this plan.

## Implementation Order

1. Add `recordChatLlmUsage` method to `UsageBillingRepository` (with unit tests)
2. Thread `accountId` and `threadId` through `invokeOnboardingLlm()`
3. Add usage recording after LLM calls in `invokeOnboardingLlm()` (aggregate or per-call)
4. Update `billing-enforcement-semantics.md`
5. API tests for recording behavior

## Verification

### Repository tests (`packages/db/src/usage-billing-repository.test.ts`)

1. `recordChatLlmUsage` creates `llm.input_tokens`, `llm.output_tokens`, `llm.cached_input_tokens` events
2. Events are rated against the rate card and debited from the period balance
3. Idempotency key prevents duplicate charges on retry
4. Missing account → no-op (no crash)
5. No open period → period is created, then events recorded

### API tests (`apps/api/src/routes/chat.test.ts`)

6. Sending a message that results in LLM calls records usage events via `usageBillingRepo`
7. Aggregate token counts match the sum of individual `callLlmProvider` results
8. When `usageBillingRepo` is not provided (billing disabled), no crash
9. When usage recording throws, chat response is still delivered
10. Failed LLM calls (provider error) do NOT record usage

## Clarifying Questions

Before proceeding with implementation, the following decisions need confirmation:

### Q1. Aggregate vs per-call recording (D1)

Should we record usage once per message (aggregate all tool-loop calls), or once per individual LLM call? Aggregate is simpler and produces cleaner billing records. Per-call gives more granular cost attribution but adds DB overhead.

### Q2. Full rating vs raw events (D2)

Should we use `recordAndRateUsageBatch` (immediate rating + ledger) or `recordUsageEvents` (raw events, rated later by reconciliation)? Full rating is more correct but requires period/plan resolution plumbing.

### Q3. Plan config source for the repo method (D6)

How should the new `recordChatLlmUsage` repo method get plan-level parameters (included credit, caps)?
- (a) Read from `billingAccounts` row (already stores `activePlanId`, caps)
- (b) Pass as parameters from the API handler
- (c) Store plan config in the repo at construction time

### Q4. Billing enable/disable toggle

The chat route currently passes `usageBillingRepo` (always constructed). Should we add an explicit `enabled` flag to skip recording when billing is disabled, mirroring the worker's `UsageBillingServiceConfig.enabled`? Or is the repo being `null`/`undefined` sufficient?

### Q5. Scope: other chat surfaces

This plan covers Guided Setup chat only. Should we also plan for metering general "Chat With AI" usage (future phase), or is Guided Setup the only chat surface that makes LLM calls today?

---

## Relationship to Other Plans

- **Plan 002** (`002-zero-balance-billing-enforcement`): Implemented the `canSpendNow` guard for agent runtime. This plan's metering makes the gate more accurate — chat spend is reflected immediately in available credit.
- **Plan 003** (`003-guided-setup-billing-gate`): Implemented the billing gate for Guided Setup chat. This plan adds the metering side — together they form the complete "wire chat to user costs" picture.
- **ADR 005** (`005-onboarding-chat-agent-runtime-model`): Declares chat is billed per-token. This plan implements that declaration.
