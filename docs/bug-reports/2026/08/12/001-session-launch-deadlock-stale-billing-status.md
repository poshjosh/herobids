# 001 — Stale `hard_limited` billing status deadlocks agent session launches

- **Status:** FIXED
- **Severity:** HIGH
- **Date:** 2026-08-12
- **Discovered:** Staging agent evaluation session (`.ignore/eval/2026/08/12/`), then reproduced during a maintenance agent restart
- **Environment:** staging (Hetzner, staging.openaidom.com)

## Summary

`agent-session-manager.ts` gates session launches on the **persisted** `billing_accounts.status` without recomputing it first. A stale `hard_limited` status — e.g. left behind by an older agent-container image whose `computeSpendStatus` semantics differed from the currently deployed code — blocks every session launch, and because status recomputation only happens in paths that require a running session or a billing event (top-up, subscription webhook, spend-caps), the account can never self-heal: **agent starts are permanently deadlocked**.

## Symptoms

- Worker log on session start:
  ```
  WARN (agent-session-manager): Session launch blocked by billing spend state
      agentId: "78516e1a-…" / "89a58bd7-…"
  ```
- Agents remain `stopped`; queued `starting` sessions are marked `stopped` by the gate.
- `billing_accounts.status` = `hard_limited` with a **positive** balance:
  `balance_microusd = 9,027,454` (≈ $9.03), `soft_cap = 5,000,000`, `hard_cap = 0`.
- Under the currently deployed `computeSpendStatus` (balance ≤ cap), that state evaluates to `active` — the persisted `hard_limited` is wrong.

## Root Cause

The launch path in `apps/worker/src/agents/agent-session-manager.ts` (~line 350-400):

1. Reconciles the billing account + open period via `getOrCreateBillingAccountForUser(...)` and `getOrCreateOpenPeriod(...)`, with the comment "Gate check AFTER reconciliation — spend state is now fresh."
2. Immediately calls `usageBillingRepo.canSpendNow(accountId)`.

But `getOrCreateOpenPeriod` **only recomputes** the account status when the open period's `includedCreditMicrousd` increased or its caps changed (`creditIncreased || capsChanged` in `packages/db/src/usage-billing-repository.ts`). When neither changed — the normal case on every session start — the persisted `billing_accounts.status` is left as-is, and `canSpendNow` short-circuits on it:

```ts
if (period.status === 'hard_limited') {
  return { canSpend: false, …, status: 'hard_limited', reason: 'hard_limited' };
}
```

So the gate trusts a possibly stale status instead of re-deriving it.

### How the status became stale (this incident)

- Commit `9afbf163` ("Fix billing", 2026-08-12 15:44 +0200) changed **both** the starter-plan caps (`hardCapCents: 200 → 0`) and `computeSpendStatus` (from `netOutOfPocket >= hardCap` to `balance <= hardCap`).
- The deploy at ~17:39 UTC rebuilt `herobids-agent:latest`, but the two running agent containers (up 24 h / 10 h) kept executing the **old image**. After the new worker reconciled the open period's caps to `hard_cap = 0`, every usage batch from the old-code containers recomputed status with the old formula: `netOutOfPocket(0) >= hardCap(0)` → always `hard_limited`, even with +$9.03 balance (`last_evaluated_at` updated every ~60 s).
- Once the agents were stopped for a maintenance restart, the stale `hard_limited` blocked relaunch, and no path recomputed it: no running session (so no usage batch), no top-up/subscription webhook, no spend-caps call. **Deadlock.**

This is the same class of bug as `docs/bug-reports/2026/08/06/001-subscription-upgrade-not-reconciling-billing-period.md`: a billing path assumes the persisted status is fresh when it is not.

## Reproduction

1. Have an account whose persisted `billing_accounts.status` is `hard_limited` (or `suspended`) while the open period's balance/caps would evaluate to `active`.
2. Stop the agent and start it again (API `POST /api/agents/:id/start` or maintenance restart).
3. The launch gate rejects the session; the agent stays `stopped` indefinitely. No subsequent session-start attempts can succeed on their own.

## Workaround applied (staging)

- `POST /api/billing/spend-caps` with the plan's current caps (`{softCapCents:500, hardCapCents:0}`) → `setSpendCaps` + `recomputeSpendState(account.id)` → status `active` (from live period data).
- Then `POST /api/agents/:id/start` succeeded; both agents relaunched on the new image and the status stayed `active` after fresh usage batches.

Note: the route has no `isAdmin` check in code (only the UI hides it), which is how this non-admin account could trigger the recompute.

## Recommended Fix

Make the launch gate derive the spend status from fresh data instead of trusting the persisted value:

1. In `agent-session-manager.ts`, call `usageBillingRepo.recomputeSpendState(billingAccount.id)` **after** `getOrCreateOpenPeriod(...)` and **before** `canSpendNow(...)`. `recomputeSpendState` re-evaluates the open period with the currently deployed `computeSpendStatus` and persists the corrected status — cheap, idempotent, and bounded (one row read + conditional update). ✅ Applied.
2. Alternatively/additionally, make `canSpendNow()` re-derive the status from the period when the persisted status is a spend-state value (`hard_limited`/`soft_limited`), so no caller can ever trust a stale spend status. (Not applied — deferred.)
3. Consider running `recomputeSpendState` for affected accounts at worker startup (or as a startup sweep for accounts with agents in `active`/`starting` state) so a code-version rollover cannot strand accounts. (Not applied — deferred.)
4. Add a regression test: persisted `hard_limited` + period balance above hard cap ⇒ `recomputeSpendState` returns `active` and the launch gate proceeds. ✅ Applied.

## Fix

**File:** `apps/worker/src/agents/agent-session-manager.ts`

In the launch gate, after `getOrCreateOpenPeriod(...)`, call `recomputeSpendState(billingAccount.id)` inside the existing fail-open try/catch before `canSpendNow(...)`. `recomputeSpendState` re-derives the account status from the open period using the currently deployed `computeSpendStatus`, so a stale persisted `hard_limited`/`soft_limited` (e.g. written by an older worker image running different billing semantics) is corrected before the gate reads it. On any billing-DB error the existing fail-open path still allows the launch.

**File:** `apps/worker/src/agents/agent-session-manager.test.ts`

- Added `recomputeSpendState` and `canSpendNow` to the billing-repo mock used by the existing "opens a billing account and period" test.
- Added regression test: "recomputes spend state before gating so a stale persisted hard_limited status cannot deadlock launch" — mocks a `hard_limited` account row, a fresh recompute returning `active`, and asserts `recomputeSpendState` is called with the account id **before** `canSpendNow`.

## Files Changed

- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agents/agent-session-manager.test.ts`

## Verification

- `pnpm lint` (tsc --noEmit) passes.
- `vitest run src/agents/agent-session-manager.test.ts` — 64 tests pass, including the new regression test.
- Operational evidence from staging (2026-08-12): after the same stale-status state was unblocked manually, agents relaunched on the new image and each subsequent usage batch recomputed the account to `active`, which is exactly what the new `recomputeSpendState` call now guarantees at launch time.

## Related

- `docs/bug-reports/2026/08/06/001-subscription-upgrade-not-reconciling-billing-period.md`
- Commit `9afbf163` "Fix billing" (cap + `computeSpendStatus` semantic change that exposed the stale-status risk)
- Commit `c6a5af0d` "Fix maintenance restart script" (the restart that surfaced this deadlock after fixing the agent-discovery query)
- Evidence: `.ignore/eval/2026/08/12/_shared/logs/worker.log`, `.ignore/eval/2026/08/12/_shared/db/billing_accounts.csv`
