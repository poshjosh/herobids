# 001 — Subscription upgrade leaves account hard_limited: billing period not reconciled on subscription webhook

- **Status:** FIXED
- **Severity:** HIGH
- **Date:** 2026-08-06
- **Discovered:** Agent evaluation session — user subscribed to starter plan; billing page still showed "Usage limit reached" and "$X over limit"
- **Environment:** staging (Hetzner, staging.openaidom.com)

## Summary

A user on the `free` plan hit the usage hard limit (account `hard_limited`, negative balance). They then subscribed to the **starter** plan via Creem. Payment succeeded, the plan updated to `starter`, but the billing page **continued to show**:

- "Usage limit reached — AI agent actions are paused until your limit is adjusted or the billing period resets."
- "$0.2977 over limit"

The subscription webhook updated the plan entitlements (`users.plan_id`, `billing_subscriptions`, `billing_accounts.active_plan_id`) but **never reconciled the open usage billing period** — so the period kept the free-plan caps (`hard_cap_microusd = 0`) and negative balance, and the account stayed `hard_limited`.

## Symptoms

- Billing page shows `hard_limited` status banner and "over limit" gauge after a successful paid subscription upgrade.
- `users.plan_id` = `starter`, `billing_subscriptions` = `starter`/`active`, `billing_accounts.active_plan_id` = `starter` — all correct.
- `billing_accounts.status` = `hard_limited`, `hard_cap_microusd` = `0`, `soft_cap_microusd` = `0`.
- Open `billing_periods` row: `plan_id_snapshot` = `free`, `included_credit_microusd` = `0`, `balance_microusd` negative, `hard_cap_microusd` = `0`.
- No `included_credit` or `plan_change_adjustment` ledger entry for the upgrade.

## Root Cause

In `apps/api/src/billing/entitlement-sync.ts`, `handleSubscriptionChange` updated the plan entitlements but did **not** reconcile the usage billing account's open period. It called:

1. `upsertSubscriptionAndSyncPlan(...)` — updates `users.plan_id` / `billing_subscriptions` ✅
2. `getOrCreateBillingAccountForUser(userId, targetPlanId)` — updates `billing_accounts.active_plan_id` ✅

but **never** called `getOrCreateOpenPeriod` or `recomputeSpendState`. Only `handleTopUpCompleted` did that.

As a result, the open `billing_periods` row (opened while on `free`) kept:
- `included_credit_microusd = 0` (no starter $20 credit added)
- `hard_cap_microusd = 0` (free-plan cap, not starter's $2.00)
- a negative `balance_microusd` from prior usage

`computeSpendStatus` (`packages/db/src/usage-billing-repository.ts`) then computed `netOutOfPocket = max(0, -balance) > hardCapMicrousd (0)` → `hard_limited`. The billing page reads this stale period/status directly and kept showing both messages.

### Live data confirmation (staging DB)

| Table | Value |
|---|---|
| `users.plan_id` | `starter` |
| `billing_subscriptions` | `starter`, `active`, provider `creem` |
| `billing_webhook_events` | `creem.subscription.updated`, status `processed` |
| `billing_accounts.active_plan_id` | `starter` |
| `billing_accounts.status` | `hard_limited` |
| `billing_accounts.hard_cap_microusd` | `0` |
| `billing_periods.plan_id_snapshot` | `free` |
| `billing_periods.included_credit_microusd` | `0` |
| `billing_periods.balance_microusd` | `-333883` (≈ -$0.33) |
| `billing_periods.hard_cap_microusd` | `0` |
| `billing_ledger_entries` | only `usage_charge`; no `included_credit` / `plan_change_adjustment` |

### Not a regression from the nginx/Caddy change

The nginx change (`docs/bug-reports/2026/08/05/003-nginx-websocket-events-404.md`) only affects the **local dev web container** (`docker/nginx.conf`). Staging uses **Caddy**, not nginx. The Caddyfile routes `/billing/*` and `/api/*` correctly — the webhook reached the API (proven by the `processed` webhook event and subscription record). The `eventType`/`event_type` fix and the `checkout.completed` fix are both present and working.

This is a **gap in the subscription entitlement-sync path**, not a routing regression.

## Fix

**File:** `apps/api/src/billing/entitlement-sync.ts`

In `handleSubscriptionChange`, after `upsertSubscriptionAndSyncPlan`, reconcile the usage billing account and open period for the new plan and recompute spend state — mirroring what `handleTopUpCompleted` and the worker's `agent-session-manager` already do:

- Apply the new plan's caps to the billing account, **refreshing plan-derived caps while preserving user-set caps**: a `resolveCapForUpgrade` helper compares the account's current caps against the old plan's configured caps. If they match the old plan (or are `null`), they are treated as plan-derived and refreshed to the new plan's caps. If they differ from the old plan's caps, they are treated as user-set and preserved.
- Resolve the plan's `includedCreditMicrousd`, `softCapMicrousd`, `hardCapMicrousd` from `plansConfig`, falling back to the account's effective caps.
- Call `getOrCreateOpenPeriod(...)` with those values. `getOrCreateOpenPeriod` reconciles the open period **independently for credit and caps**: included credit increases (downgrades take effect next period), and the period's cap fields are refreshed whenever they differ from the caller's effective caps (so a cap-only change is also applied). It recomputes account status when credit increases.
- Call `recomputeSpendState(account.id)`.

This adds the starter included credit to the open period (clearing the negative balance), applies the starter caps to the account/period, and recomputes status → `active` (or `soft_limited`), clearing both messages.

### Tests

**File:** `apps/api/src/billing/entitlement-sync.test.ts`

- Updated existing subscription tests to include the new `getAccountByUserId` / `ensureActiveRateCard` / `getOrCreateOpenPeriod` / `recomputeSpendState` mocks.
- Added test: "reconciles the open period with the upgraded plan included credit and caps" — verifies the plan caps are applied to the account (when none set) and `getOrCreateOpenPeriod` is called with the upgraded plan's included credit and caps, and `recomputeSpendState` is called.
- Added test: "refreshes stale plan-derived caps to the upgraded plan caps on subscription upgrade" — verifies an existing account with old-plan caps (free: 0 / $1) is refreshed to the new plan's caps (pro: $3 / $5).
- Existing "preserves existing user-set spend caps" test now asserts the account's user-set caps (1M / 2M) are preserved (plan caps not passed) and the period is reconciled with those caps.

**File:** `packages/db/src/usage-billing-repository.test.ts`

- Added test: "refreshes the open period caps to the upgraded plan caps on upgrade" — verifies `getOrCreateOpenPeriod` updates the existing open period's `softCapMicrousd` / `hardCapMicrousd` to the new plan's caps on upgrade.
- Added test: "refreshes the open period caps even when included credit is unchanged" — verifies a cap-only change reconciles the period caps without a credit delta or ledger entry.
- Added test: "no-op when neither credit nor caps change" — verifies no update occurs when both are unchanged.
- Existing credit-reconciliation tests updated to pass caps matching the existing period so they isolate credit behavior.

## Verification

- `pnpm lint` passed.
- `pnpm --filter @herobids/api exec vitest run src/billing/entitlement-sync.test.ts` — 17 tests passed.
- `pnpm --filter @herobids/db exec vitest run src/usage-billing-repository.test.ts` — 32 tests passed.

## Follow-up (data hygiene)

The affected staging account's open `billing_periods` row was opened with free-plan values. After deploying this fix, the next subscription webhook (or a manual reconciliation) will add the starter included credit and recompute status. If the user's account should be corrected immediately without waiting for a new webhook, run a one-time reconciliation (re-run `getOrCreateOpenPeriod` + `recomputeSpendState` for the account) after deploy.

> **Note on deployed config:** The staging deployment currently ships `config/default.yaml` with `hardCapCents: 0` for both `free` and `starter` (the local repo's `hardCapCents: 100`/`200` change is not yet deployed). With the included-credit reconciliation, the balance becomes positive and `netOutOfPocket = 0`, so the account returns to `active` regardless of the hard cap. The cap-application logic matters once the intended caps (100/200) are deployed.
