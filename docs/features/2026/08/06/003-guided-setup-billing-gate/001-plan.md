# Plan: Guided Setup — Billing Gate (No Money, No Form)

**Feature:** Guided Setup billing enforcement (003)
**Date:** 2026-08-06
**Status:** Draft

## Summary

Wire the AI-assisted / Guided Setup agent-creation chat to user costs. The product rule is **"no money, no form"**: a user with no available billing credit must not be able to consume paid platform resources (LLM calls) through the Guided Setup chat, and must not be able to create an agent they cannot run.

We already set a hard cap that allows a small amount of spend over the limit so new users can see the form. This plan handles the case where the hard cap is reached (or available credit is exhausted): the chat is blocked with a clear, actionable top-up gate instead of a raw error.

This plan is **consistent with** `docs/features/2026/08/06/002-zero-balance-billing-enforcement/001-plan.md` (the moved pending enforcement plan). It **reuses the same shared `canSpendNow` guard** that plan proposes, so runtime and onboarding enforcement share one source of truth.

## Decisions (confirmed)

1. **Plain create-agent form is NOT gated.** Only the Guided Setup chat (which makes paid LLM calls) is gated. The form's agent creation remains allowed — it creates a `stopped` agent, and running is already blocked downstream. "No money, no form" applies to the paid chat surface, not the free form.
2. **Gate on available credit (Plan 002's stricter rule), not just `hard_limited` status.** Paid work is blocked when `availableCredit = balanceMicrousd - reservedMicrousd <= 0`, even if account status is still `active`.
3. **`create_agent` is blocked (Option A).** Defense-in-depth: the `create_agent` tool case also checks `canSpendNow` and returns a `billing.top_up_required` tool result when blocked.
4. **HTTP status code is `402 Payment Required`** for the billing block.
5. **Top-up gate links to `/billing`** (reuses existing top-up UI). A direct inline top-up checkout is out of scope.

## Relationship to the Zero-Balance Enforcement Plan (002)

Plan 002 enforces a no-funds gate for **agent runtime** paid work (session start + scout/judge/hybrid LLM dispatch) based on available credit, not just cap-derived status. It proposes a shared billing guard in `packages/db/src/usage-billing-repository.ts`:

- `canSpendNow(accountId)` (or `getAvailableCreditState(accountId)`) — returns whether paid work is allowed right now.
- Rule: paid work is blocked when `availableCredit = balanceMicrousd - reservedMicrousd <= 0`.

This plan (003) applies the **same guard** to the **Guided Setup chat** (an API-local, per-message LLM runtime). It does not duplicate billing math — it calls the same shared helper.

> **Dependency:** Plan 003 depends on the shared `canSpendNow` helper from Plan 002. If 002 is not yet merged, 003 must add the helper itself (in the same location) so both plans converge on it. The helper is small and self-contained; adding it in 003 does not conflict with 002 as long as both use the same name and location.

## Current Code Truth

Confirmed from current code:

1. **Guided Setup chat has zero billing gating.** In `apps/api/src/routes/chat.ts`, every message triggers a paid `callLlmProvider(...)` call inside `invokeOnboardingLlm(...)`. The `create_agent` tool inserts an agent directly. There is no billing check anywhere in the route (the only "billing" match in the file is a comment).

2. **The chat is invoked per-message, not continuously.** `POST /chat/threads/:id/messages` and `POST /chat/threads/:id/actions/:actionId` both call `invokeOnboardingLlm(...)`. This is the natural enforcement point — block before the paid LLM call.

3. **`create_agent` inserts a `stopped` agent.** In `executeChatAction(...)`, the agent is inserted with `status: 'stopped'`. A stopped agent costs nothing to run. Running is already blocked downstream for `hard_limited`/`suspended` accounts in `apps/worker/src/agents/agent-session-manager.ts`.

4. **Billing account + spend state are already exposed.** `GET /billing/usage-summary` (`apps/api/src/routes/billing.ts`) returns `account.status`, `currentPeriod.balanceMicrousd`, `hardCapMicrousd`, etc. The frontend client already has `billing.usageSummary()` (`apps/web/src/lib/api-client.ts:820`).

5. **`computeSpendStatus` derives `hard_limited` from caps.** `packages/db/src/usage-billing-repository.ts:1462` returns `hard_limited` when `netOutOfPocket > hardCapMicrousd`. The free plan (`config/default.yaml:855`) has `includedCreditCents: 0`, `hardCapCents: 100` → the account goes `hard_limited` once the user is **$1 over** their zero credit. That is the "some money over limit" allowance.

6. **The shared `canSpendNow` helper does not exist yet.** It is only proposed in Plan 002. It must be added (in 002 or 003).

## Problem Statement

The Guided Setup chat currently lets a user with no available credit:

- send messages that trigger paid LLM calls (the platform pays), and
- create an agent (which they then cannot run because runtime is blocked).

This violates the product rule: **no money, no form.**

## Goal

Enforce a no-funds gate on the Guided Setup chat:

- Block paid LLM calls when the user has no available credit (reusing `canSpendNow`).
- Surface a clear, actionable **top-up gate** in the UI (not a raw error) when the hard cap is reached / credit is exhausted.
- Keep the backend authoritative — the frontend gate is UX sugar, the backend guard is the guarantee.

## Non-Goals

- Do not change the plain create-agent form's behavior beyond the shared gate (the form is a fallback; see Open Questions).
- Do not change agent runtime enforcement (that is Plan 002).
- Do not change soft-cap warning semantics.
- Do not redesign the billing/top-up flow.
- Do not auto-close positions or stop running agents.

## Proposed Changes

### 1. Add the shared `canSpendNow` guard (shared with Plan 002)

**Location:** `packages/db/src/usage-billing-repository.ts`

Add a read method that answers whether paid work is allowed right now:

```ts
export interface CanSpendNowResult {
  canSpend: boolean;
  availableMicrousd: number;
  status: AccountStatus;
  reason: 'ok' | 'no_available_credit' | 'hard_limited' | 'suspended';
}

async canSpendNow(accountId: string): Promise<CanSpendNowResult> {
  // Load the open period + account status (same query shape as reserveCharge).
  // availableMicrousd = balanceMicrousd - reservedMicrousd
  // canSpend = status not in (hard_limited, suspended) AND availableMicrousd > 0
}
```

Rules (consistent with Plan 002 and `reserveCharge`):

- Block when `status` is `hard_limited` or `suspended`.
- Block when `availableMicrousd <= 0` (available = balance − reserved), **even if status is still `active`**.
- Otherwise allow.

If no billing account / open period exists (fresh user, no activity), treat as **can spend** (the account is created lazily on first activity; a brand-new user with no account should not be blocked from onboarding). This matches the existing `GET /billing/usage-summary` behavior of returning `account: null` for fresh users.

> **Note:** This is the exact helper Plan 002 proposes. Implement it once, in one place, and have both plans call it. If 002 lands first, 003 just consumes it.

### 2. Enforce the guard in the chat send endpoint

**Location:** `apps/api/src/routes/chat.ts` — `POST /chat/threads/:id/messages`

Before persisting the user message and invoking the LLM, call `canSpendNow(userId)`:

- If `canSpend === false`, return a structured billing error (do **not** persist the user message, do **not** call the LLM):

```ts
return reply.status(402).send(errorPayload(
  'billing.top_up_required',
  'You need to add credit to continue using Guided Setup.',
  { reason: result.reason, availableMicrousd: result.availableMicrousd },
));
```

- Use HTTP `402 Payment Required` so the frontend can branch on status code + error code.

**Dependency wiring:** `chatRoutes(...)` currently receives `(app, db, llmConfig, providersYaml, redisClient)`. Add a `usageBillingRepo` (or a `canSpendNow` function) parameter. Construct it in `apps/api/src/index.ts` where `chatRoutes` is registered (mirroring how `billingRoutes` constructs `new UsageBillingRepository(db, ...)`).

### 3. Enforce the guard in the action-result endpoint

**Location:** `apps/api/src/routes/chat.ts` — `POST /chat/threads/:id/actions/:actionId`

The action-result endpoint also resumes the LLM (`invokeOnboardingLlm`). Apply the same guard before the resume call:

- If `canSpend === false`, do **not** call the LLM. Return the same `billing.top_up_required` error.
- The connection-link metadata update may still be persisted (linking a connection is not a paid action), but the LLM resume must be blocked.

### 4. Decide `create_agent` behavior

`create_agent` inserts a `stopped` agent (no runtime cost). Two options:

- **Option A (strict, matches "no money, no form"):** Block `create_agent` too when `canSpend === false`. The whole flow is gated.
- **Option B (permissive):** Allow creating a `stopped` agent even when broke; running is already blocked downstream by Plan 002 / session-manager.

**Recommendation: Option A for the chat flow.** Since the chat is already gated at message-send time, a user who reaches the gate cannot get far enough to call `create_agent` anyway. But for defense-in-depth, `executeChatAction`'s `create_agent` case should also check `canSpendNow` and return a `billing.top_up_required` tool result if blocked. This keeps the backend authoritative even if the frontend gate is bypassed.

### 5. Frontend top-up gate

**Location:** `apps/web/src/features/chat/GuidedSetupPanel.tsx` (+ `useGuidedSetup.ts`)

- On mount, fetch `billing.usageSummary()`.
- If the account is `hard_limited` / `suspended`, **or** available credit `<= 0`, render a **top-up gate** instead of the chat:
  - A short explanation: "You've reached your usage limit."
  - A **"Add credit"** button that routes to the billing page (`/billing`).
  - A **"Use the form instead"** escape hatch (the plain form remains available).
- When a send/action-result returns `402` / `billing.top_up_required`, transition to the same gate (don't just show a transient error).
- Add i18n strings for the gate (en/ar/hi, matching existing locale files).

**Frontend helper:** Add a small `canUseGuidedSetup(summary)` util that computes the gate from `UsageSummaryResponse` (account status + `balanceMicrousd`), mirroring the backend rule. Keep it in `apps/web/src/features/chat/` and unit-test it.

### 6. Update billing semantics documentation

Update `docs/tech/agents/billing-enforcement-semantics.md` to note that the no-available-credit rule also applies to the Guided Setup chat (per-message LLM), not just agent runtime.

## Implementation Order

1. Add shared `canSpendNow` guard in `packages/db/src/usage-billing-repository.ts` (+ unit tests).
2. Wire `usageBillingRepo` into `chatRoutes` in `apps/api/src/index.ts`.
3. Enforce guard in `POST /chat/threads/:id/messages`.
4. Enforce guard in `POST /chat/threads/:id/actions/:actionId`.
5. Enforce guard in `create_agent` tool case (defense-in-depth).
6. Frontend: fetch usage summary, render top-up gate, handle `402`.
7. i18n strings.
8. Update `docs/tech/agents/billing-enforcement-semantics.md`.
9. Tests (API + frontend).

## Verification

### API tests (`apps/api/src/routes/chat.test.ts`)

1. Sending a message when `canSpendNow` returns `false` returns `402` with `billing.top_up_required` and does **not** call the LLM.
2. Sending a message when `canSpendNow` returns `true` proceeds normally (existing tests still pass).
3. Submitting an action result when `canSpendNow` returns `false` returns `402` and does **not** resume the LLM.
4. `create_agent` tool returns a `billing.top_up_required` tool result when blocked.
5. Fresh user with no billing account is **not** blocked (can spend).

### Repository tests (`packages/db/src/usage-billing-repository.test.ts`)

6. `canSpendNow` returns `canSpend: false` when `availableMicrousd <= 0` even if status is `active`.
7. `canSpendNow` returns `canSpend: false` when status is `hard_limited` / `suspended`.
8. `canSpendNow` returns `canSpend: true` when available credit is positive and status is `active`.
9. `canSpendNow` returns `canSpend: true` when no account / no open period exists.

### Frontend tests

10. `canUseGuidedSetup` returns `true` for a healthy account, `false` for `hard_limited` / `suspended` / zero balance.
11. `GuidedSetupPanel` renders the top-up gate (not the chat) when the gate is active.
12. A `402` response transitions the panel to the gate.

## Out of Scope

- Gating the plain create-agent form (decision 1).
- Direct inline top-up checkout in the gate (decision 5) — the gate links to `/billing`.
- Agent runtime enforcement (Plan 002).
