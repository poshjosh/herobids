# Zero-Balance Billing Enforcement

## Summary

Prevent agents from consuming paid platform resources when the user has no available billing credit.

This plan covers agent runtime enforcement for paid work, with the immediate goal that paper/shadow agents cannot continue consuming LLM or other billed runtime after available credit is exhausted.

## Current Code Truth

These points are confirmed from current code.

1. Agent runtime billing is post-charge.
   - LLM usage is recorded after the call returns in `apps/worker/src/agent.ts` via `usageBillingService.recordLlmUsage(...)`.
   - Runtime windows are recorded after elapsed time in `apps/worker/src/usage-billing-service.ts` via `doRecordRuntimeWindow(...)`.

2. Agent runtime gating is status-based, not balance-based.
   - Session start blocks only when `billingAccount.status` is `hard_limited` or `suspended` in `apps/worker/src/agents/agent-session-manager.ts`.
   - Tick-time LLM dispatch blocks only when `usageBillingService.isHardLimited()` is true in `apps/worker/src/agent.ts`.

3. Spend state is cap-based.
   - `computeSpendStatus(...)` in `packages/db/src/usage-billing-repository.ts` derives status from `netOutOfPocket` versus `softCapMicrousd` and `hardCapMicrousd`.
   - Negative balance alone does not force `hard_limited`.

4. The repo default `free` plan has no spend caps.
   - In `config/default.yaml`, `plans.free.usage` sets `includedCreditCents: 0` and does not set `softCapCents` or `hardCapCents`.

5. Assessment requests already use pre-authorization.
   - `reserveCharge(...)` in `packages/db/src/usage-billing-repository.ts` checks `availableMicrousd = balanceMicrousd - reservedMicrousd` before allowing an assessment request.

## Problem Statement

The current runtime path allows this failure mode:

- a user has zero or negative available credit,
- the billing account remains `active`,
- the agent is still allowed to start and keep making paid runtime calls,
- charges are applied only after usage,
- while assessment requests fail because they require reserveable credit up front.

This violates the desired product rule:

- if the user does not have money available, they must not be able to consume paid platform resources.

## Goal

Enforce a no-funds gate for paid runtime work based on available credit, not only on cap-derived account status.

## Non-Goals

- Do not change trading strategy behavior.
- Do not auto-close positions when billing blocks an agent.
- Do not change soft-cap warning semantics unless needed for consistency.
- Do not change assessment request reservation semantics except to align shared helpers.

## Proposed Changes

### 1. Introduce an authoritative "can spend now" check

Add one shared billing guard that answers whether paid work is allowed right now.

Recommended rule:

- paid work is blocked when available credit is `<= 0`
- available credit is computed as `balanceMicrousd - reservedMicrousd`

Recommended location:

- `packages/db/src/usage-billing-repository.ts`
- expose a read method such as `getAvailableCreditState(accountId)` or `canReserveAmount(accountId, amountMicrousd)`

Why:

- this uses the same financial basis already used by assessment reservations
- it avoids duplicating billing math in worker runtime code

### 2. Enforce the guard at session start

Update `apps/worker/src/agents/agent-session-manager.ts` so session launch is blocked not only for `hard_limited` and `suspended`, but also when there is no available credit for paid runtime.

Behavior:

- stop the session before launch
- set a billing-specific reason such as `billing.insufficient_funds` or `billing.top_up_required`
- do not allow a new runtime session to start in a no-funds state

### 3. Enforce the guard before every paid LLM dispatch

Update `apps/worker/src/agent.ts` so scout, judge, and hybrid LLM flows check available credit before dispatch, not only `isHardLimited()`.

Scope:

- scout loop
- judge loop
- hybrid evaluator path

Behavior:

- if there is no available credit, skip the tick before any paid LLM call
- emit the existing billing-style activity event
- keep the stop operational, not strategic

### 4. Move runtime enforcement toward pre-authorization

The current zero-balance gate is necessary but still weaker than assessment-style reservation.

Add a second slice that pre-authorizes runtime consumption before use.

Recommended direction:

- reserve a bounded runtime allowance before paid work begins
- settle or release it after actual usage is known

This can be phased:

- Phase 1: zero-available-credit gate before use
- Phase 2: true reservation for runtime and LLM usage

### 5. Keep assessment requests under the same stricter rule

Assessment requests already require reserveable credit.

Do not loosen that path.

Instead:

- reuse the same shared billing guard so runtime and assessment behavior are consistent

### 6. Update plan/config semantics for staging and free

The current `free` plan has no caps, which means status-based enforcement alone will not protect against zero-balance spending.

Recommended change:

- do not rely on `hardCapCents = 0` as the main fix
- keep explicit config for plan caps if desired,
- but make runtime enforcement depend on available credit regardless of cap presence

This keeps the desired rule true even when caps are unset.

### 7. Update billing semantics documentation

Update `docs/tech/agents/billing-enforcement-semantics.md` to reflect:

- hard-cap semantics still exist,
- but zero / no-available-credit is an independent block for paid runtime,
- runtime spending is not allowed to continue purely because status is still `active`.

## Implementation Order

1. Add shared available-credit read/check in billing repository.
2. Apply it at session start.
3. Apply it before scout/judge/hybrid LLM dispatch.
4. Add billing-specific blocked reason and notifications.
5. Update documentation.
6. Add follow-up slice for runtime reservation/pre-authorization.

## Verification

Add tests for these cases:

1. Agent session launch is blocked when available credit is `<= 0` even if account status is still `active`.
2. Scout tick is skipped before LLM dispatch when available credit is `<= 0`.
3. Judge tick is skipped before LLM dispatch when available credit is `<= 0`.
4. Hybrid evaluator is skipped before LLM dispatch when available credit is `<= 0`.
5. Assessment requests remain blocked when available credit is insufficient.
6. Positive available credit still allows runtime.

## Open Questions

1. Should runtime block at `available <= 0`, or only when available credit is less than a minimum reserve amount for the next unit of work?
2. Should `agent.runtime_ms` also move to a reservation model, or is pre-dispatch gating sufficient for the first slice?
3. Do we want one common user-facing reason code for all no-funds cases, or separate codes for `no_available_credit` and `cap_exceeded`?