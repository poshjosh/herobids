# Billing period not updated on plan change — included credit shows $0 after upgrade

**Date:** 2026-08-03
**Severity:** HIGH
**Status:** FIXED

**Fix:** `packages/db/src/usage-billing-repository.ts` — `getOrCreateOpenPeriod` now reconciles `includedCreditMicrousd` when an existing period is found. On upgrade (new > existing), the period is updated in-place with a delta ledger entry (`plan_change_adjustment`) — `planIdSnapshot` remains frozen as the plan that opened the period, preserving the audit trail. On downgrade or same-credit plan change, no update occurs — included credit is preserved per standard SaaS downgrade semantics (takes effect next period).

## Summary

When a user upgrades plans mid-period (e.g. free → starter), the existing open billing period retains the old plan's `includedCreditMicrousd` and `plan_id_snapshot`. The billing page then displays `$0.0000 Included with {newPlan}` because the period was created under the free plan. Any actual credit in the balance (from included credits or top-ups) is misattributed entirely as "top-ups".

## Confirmed Root Cause

`getOrCreateOpenPeriod` in `packages/db/src/usage-billing-repository.ts:311` returns an **existing** open period as-is without checking whether the current plan's `includedCreditMicrousd` or `plan_id_snapshot` differ from what's stored. No caller updates these fields after the fact either.

### DB Evidence (local docker compose)

**Timeline of events:**

| Time (UTC) | Event | Effect |
|---|---|---|
| 11:31:49 | Agent starts while user on **free** plan | Period created: `plan_id_snapshot = 'free'`, `included_credit_microusd = 0`, `balance_microusd = 0` |
| 11:31:52 | `subscription.created` webhook (mock) | `users.plan_id` → `'starter'`, `billing_accounts.active_plan_id` → `'starter'`. **Period NOT updated.** |
| 11:32–11:36 | Agent runtime usage events | `usage_charge_microusd` incremented (~$0.006), balance decremented |
| 11:35:09 | `top_up.completed` webhook (mock, Topup20) | `balance_microusd` incremented by 20,000,000 ($20). `handleTopUpCompleted` called `getOrCreateOpenPeriod` with `includedCreditMicrousd = 20,000,000` (from starter config) — but the existing period was returned as-is, value silently ignored. |

**Resulting period row:**
```
plan_id_snapshot        = 'free'       ← wrong (should be 'starter')
included_credit_microusd = 0           ← wrong (should be 20,000,000)
balance_microusd         = 19,993,800  ← correct sum (0 + 20,000,000 top-up − 6,200 usage)
```

**Resulting display:**
```
$0.0000 Included with starter + $19.9938 top-ups
```

The plan label "starter" comes from the subscription summary (`billing_subscriptions.plan_id`), while the `$0.0000` included credit comes from the period's `included_credit_microusd` (still 0 from free plan). The $20 balance from the top-up is displayed as "top-ups" because: `topUpMicrousd = max(0, balance + usageCharge - includedCredit) = max(0, 19,993,800 + 6,200 − 0) ≈ 20,000,000`.

## Affected Code

### Core issue
- `packages/db/src/usage-billing-repository.ts:338-347` — `getOrCreateOpenPeriod` returns existing period without reconciling `includedCreditMicrousd` or `plan_id_snapshot` against current plan.

### Places that pass `includedCreditMicrousd` to `getOrCreateOpenPeriod` (value silently dropped if period exists)
- `apps/worker/src/agents/agent-session-manager.ts:407` — agent session start
- `apps/worker/src/usage-billing-service.ts:102` — agent container runtime billing
- `apps/api/src/billing/entitlement-sync.ts:95` — top-up webhook processing (also passes correct `includedCreditMicrousd` but it's ignored)
- `apps/worker/src/market-intelligence/assessment-request-service.ts:978` — hardcodes `0` with comment "plan-based credits are not yet wired"

### Frontend (amplifies the data bug)
- `apps/web/src/features/billing/BillingPage.tsx:51` — `topUpMicrousd = max(0, totalCredit - includedCredit)` — when `includedCredit` is 0, all positive balance appears as "top-ups"
- `apps/web/src/features/billing/BillingPage.tsx:516` — `totalCreditMicrousd = balanceMicrousd + usageChargeMicrousd`

## Impact

- Users who upgrade mid-month see $0 included credit for the current period
- The included credit from the new plan is not reflected until the NEXT calendar month when a new period opens
- Any credit in the balance is incorrectly labeled as "top-ups" on the billing page
- The `plan_id_snapshot` on the period is stale, which could affect audit trails and downstream reporting

## Reproduction

1. Start with a user on the free plan (or any plan with `includedCreditCents: 0`)
2. Start an agent → billing period opens with `included_credit_microusd = 0`
3. Upgrade the user to starter plan (or any plan with `includedCreditCents > 0`)
4. Visit billing page → "Included with starter" shows $0.0000
5. (Optional) Purchase a top-up → the top-up amount appears correctly but the included credit stays $0

## Recommended Fix Direction

`getOrCreateOpenPeriod` should detect when the existing period's `plan_id_snapshot` or `includedCreditMicrousd` no longer matches the caller's intent. Options:

1. **Update in-place:** If the period exists and `includedCreditMicrousd` differs from the passed value, update the period row and issue a corrective ledger entry for the delta.
2. **Close and reopen:** Close the stale period and open a new one with the correct plan values. This preserves a clean audit trail but is more complex.

Option (1) is simpler and avoids fragmenting a single calendar month's billing across multiple periods. The delta ledger entry would be an `included_credit` adjustment.

## Confirmed DB Queries (for reference)

```sql
-- Period: shows plan_id_snapshot='free', included_credit=0 despite user on starter
SELECT plan_id_snapshot, included_credit_microusd, balance_microusd,
       usage_charge_microusd, status, period_start
FROM billing_periods WHERE status = 'open';

-- Ledger: shows included_credit=0 entry, usage charges, and a top_up_credit=20000000
SELECT entry_type, direction, amount_microusd, description, created_at
FROM billing_ledger_entries
WHERE period_id = 'period_acct_1e875ad_2026-08'
ORDER BY created_at;

-- Account: active_plan_id='starter'
SELECT active_plan_id FROM billing_accounts;

-- User: plan_id='starter'
SELECT plan_id FROM users;

-- Subscription: starter plan, active
SELECT plan_id, status, provider FROM billing_subscriptions;
```
