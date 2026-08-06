# Zero-Balance Billing Enforcement

**Status: ✅ Implemented** (2026-08-06)


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

4. The repo default `free` plan DOES set spend caps.
   - In `config/default.yaml`, `plans.free.usage` sets `includedCreditCents: 0`, `softCapCents: 0`, and `hardCapCents: 100`.
   - So status-based enforcement partially protects free users (they go `hard_limited` at $1 over zero credit). But this is a cap-derived block, not a balance-based one — a user with negative available credit but a raised/removed cap (or a plan with no cap) can still consume paid runtime while `active`.

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
- expose a single read method `canSpendNow(accountId)` returning a structured result (below)

> **Shared helper contract (align with Plan 003):** Both this plan and Plan 003 must converge on ONE helper signature. Use the richer shape below (includes `status` and `reason`), which Plan 003 already specifies. Implement it once, here in Plan 002; Plan 003 consumes it.

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

Why:

- this uses the same financial basis already used by assessment reservations
- it avoids duplicating billing math in worker runtime code

### 2. Enforce the guard at session start

Update `apps/worker/src/agents/agent-session-manager.ts` so session launch is blocked not only for `hard_limited` and `suspended`, but also when there is no available credit for paid runtime.

> **Ordering:** The gate must run AFTER the existing period reconciliation in `agent-session-manager.ts` (lines ~356-395), which calls `getOrCreateOpenPeriod` + `getSpendState`. That reconciliation refreshes credit/caps (e.g. after a plan upgrade) and recomputes status, so gating on stale pre-reconciliation state would be wrong. Read `canSpendNow` after the reconciliation.

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

The `free` plan's caps (`softCapCents: 0`, `hardCapCents: 100`) are cap-derived and only block once the user is $1 over zero credit. A user with negative available credit but a raised/removed cap (or a plan with no cap) can still consume paid runtime while `active`.

Recommended change:

- do not rely on `hardCapCents` as the main fix
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
5. Update documentation (`docs/tech/agents/billing-enforcement-semantics.md`) — do this ONCE here, in Plan 002. Plan 003 adds only its chat-surface note on top; do not have both plans edit the file independently (merge-conflict risk).
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
---

## Outstanding Issues (from implementation review)

These are medium/low-severity findings from the implementation code reviews. None block the feature; all are tracked for future cleanup.

### Item 1 — `canSpendNow` shared guard

- **Medium**: Missing test for unknown-status safety net (M2 fallback path). Add a test injecting an unrecognized status string and asserting conservative block.
- **Medium**: `reserveCharge` lacks the same unknown-status safety net as `canSpendNow` — consistency gap across the billing repository.

### Item 2 — Session start enforcement

- **Medium**: Unknown billing status mapped as `hard_limited` → guardrail says "limit exceeded" when the real problem is an unrecognized/unknown status. Consider adding an `unknown_status` reason to `CanSpendNowResult` or a distinct code.
- **Low**: Nested ternary chains for reason→code mapping could be refactored to a `switch` statement for readability and extensibility.
- **Low**: Test coverage gap — blocked-launch path not tested at integration level (session manager unit tests don't exercise the billing gate).

### Item 3 — LLM dispatch enforcement

- **Medium**: Duplicate reason→code mapping in hybrid and scout paths. Extract to a shared helper function (e.g. `billingBlockReason(reason)`) to avoid drift when new reasons are added.
- **Medium**: `resolveForcedPreScoutBillingOutcome` has a dead `reason` field (`'billing.limit_exceeded'`) that the caller never reads; and the parameter name `isHardLimited` is misleading (it's actually `!canSpendResult.canSpend`, conflating three distinct states). Rename to `isBlocked` and remove or wire through the reason.
- **Medium**: No billing re-check between scout and judge LLM dispatch within the same tick — if the scout exhausts the remaining credit, the judge runs un-gated. Pre-existing behavior; file as Phase 2 follow-up.

### Item 4 — Billing notification reason codes

- **Medium**: New blocking-message builders (`buildInsufficientFundsMessage`, `buildAccountSuspendedMessage`) omit open-position warnings that `buildHardLimitMessage` includes — consistency gap for users with open positions.
- **Low**: `isHard` computation includes dead-code reasons (`insufficient_funds`, `account_suspended`) already caught by explicit checks above — can be simplified to only check `billing.limit_exceeded`.
- **Low**: Pre-existing 24h dedup TTL causes re-notification for agents blocked >24 hours.

### Item 5 — Billing enforcement docs

- **Low**: `guardrail_triggered` event missing from the Activity Events table — only `TICK_SKIPPED` entries are documented, but session-start blocking emits `guardrail_triggered`.

### Final review gaps

- **Low**: `UsageBillingService.isHardLimited()` legacy method retained as public API even though all production paths migrated to `canSpendNow()`. Mark as `@deprecated` or remove.
- **Low**: Free plan `hardCapCents: 100` in `config/default.yaml` is now a redundant safety net. Add a comment noting that primary enforcement is balance-based via `canSpendNow()`.

### Commits (9 on top of `origin/main`)

```
187c0348 docs: add zero-balance billing enforcement to CHANGELOG
715c9437 test: fix assessment-request-service mock for canSpendNow
a0d459a2 fix: address 3 gaps from zero-balance enforcement final review
5531a764 test: add verification tests for zero-balance billing enforcement
a8f95e57 docs: update billing enforcement semantics for zero-balance enforcement
3538cc02 feat: add billing notification handling for insufficient_funds and account_suspended
ee989541 feat(worker): apply canSpendNow billing gate before LLM dispatch
7eb5aa0a feat(worker): apply canSpendNow billing gate at agent session start
bcf65d81 feat(db): add canSpendNow shared billing guard
```
