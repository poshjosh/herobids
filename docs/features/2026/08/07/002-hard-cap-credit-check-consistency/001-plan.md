# Plan: Canonical Hard-Cap Enforcement Logic

**Feature:** Consistent hard-cap semantics across all billing enforcement methods and docs
**Date:** 2026-08-07
**Status:** Planned

## Summary

Three methods define whether paid work is allowed: `computeSpendStatus`, `canSpendNow`, and `reserveCharge`. Today they do not use the same hard-cap boundary.

This plan makes the boundary explicit and consistent everywhere:

- `hardCapMicrousd = null` means **no hard cap**
- when a hard cap is set, the user is blocked **as soon as** balance / available credit reaches the cap boundary

Example: `hardCapCents: 100` means the user can spend down to just above `-$1.00`; once they hit exactly `-$1.00`, further paid work is blocked.

This exact rule must be reflected in code, tests, API-return shapes, the billing page, and the public/technical docs.

## Canonical Rule

```
If hardCapMicrousd is null: no hard cap is enforced.
If hardCapMicrousd is set: the hard-cap boundary is exact.

- computeSpendStatus: hard-limited when netOutOfPocket >= hardCapMicrousd
- canSpendNow: blocked when availableMicrousd <= -hardCapMicrousd
- reserveCharge: blocked when post-reservation availableMicrousd <= -hardCapMicrousd
```

This is the single rule. No method gets different boundary semantics.

### Unit reference

| Layer | Unit | Example |
|-------|------|---------|
| Plan config | `hardCapCents` (cents) | `100` = $1.00 |
| DB | `hardCapMicrousd` (micro-dollars) | `1_000_000` = $1.00 |

Conversion: `hardCapCents × 10_000 = hardCapMicrousd`

## Current Code Truth

### Core enforcement methods

| # | Method | File:Line | Current behavior | Required change |
|---|--------|-----------|------------------|-----------------|
| 1 | `computeSpendStatus()` | `packages/db/src/usage-billing-repository.ts:1554` | `null` = unlimited, but exact-cap boundary is still `active` because it uses `>` | **Change to exact-boundary block** |
| 2 | `canSpendNow()` | `packages/db/src/usage-billing-repository.ts:328` | Blocks at `availableMicrousd <= 0`, ignores hard cap entirely | **Change to cap-aware exact-boundary block** |
| 3 | `reserveCharge()` | `packages/db/src/usage-billing-repository.ts:1285` | Blocks at `availableMicrousd < input.amountMicrousd`, ignores hard cap | **Change to cap-aware exact-boundary block** |

### Delegating / consuming sites affected transitively

| # | Site | File:Line | Impact |
|---|------|-----------|--------|
| 4 | `UsageBillingService.canSpendNow()` | `apps/worker/src/usage-billing-service.ts:152` | Return shape update |
| 5 | Session launch gate | `apps/worker/src/agents/agent-session-manager.ts:385` | Reads `canSpendNow()` |
| 6 | Hybrid evaluator gate | `apps/worker/src/agent.ts:2599` | Reads `canSpendNow()` |
| 7 | Scout pre-check fallback | `apps/worker/src/agent.ts:3042` | Inline `CanSpendNowResult` object must match new shape |
| 8 | Assessment pre-check | `apps/worker/src/market-intelligence/assessment-request-service.ts:408` | Reads `canSpendNow()` |
| 9 | Assessment reservation path | `apps/worker/src/market-intelligence/assessment-request-service.ts:483` | Uses `reserveCharge()` |
| 10 | Guided Setup `create_agent` gate | `apps/api/src/routes/chat.ts:803` | Reads `canSpendNow()` |
| 11 | Guided Setup message/action gates | `apps/api/src/routes/chat.ts` | Reads `canSpendNow()` |

### Result-shape construction sites that must be updated explicitly

| # | Site | File:Line |
|---|------|-----------|
| 12 | `canSpendNow()` fresh-user path | `packages/db/src/usage-billing-repository.ts:347` |
| 13 | `agent-session-manager` fail-open fallback | `apps/worker/src/agents/agent-session-manager.ts:389` |
| 14 | `UsageBillingService.canSpendNow()` disabled / fail-open returns | `apps/worker/src/usage-billing-service.ts:157`, `162`, `167` |
| 15 | `agent.ts` inline no-service fallback | `apps/worker/src/agent.ts:3042` |
| 16 | `chat.test.ts` mocks | `apps/api/src/routes/chat.test.ts:1110`, `1140`, `1191` |
| 17 | `assessment-request-service.test.ts` mocks | `apps/worker/src/market-intelligence/assessment-request-service.test.ts:294`, `317` |
| 18 | `usage-billing-service.test.ts` mocks | `apps/worker/src/usage-billing-service.test.ts` |

### Other semantics surfaces that must be kept in sync

| # | Surface | File:Line | Current issue |
|---|---------|-----------|---------------|
| 19 | Billing warning computation | `apps/api/src/routes/billing.ts:615` | Treats `0` as "no effective cap" |
| 20 | Main public billing doc | `apps/web/src/features/public-pages/content/en/docs/agents/billing-limits.md` | Still explains old behavior in broad terms and does not state the exact-cap boundary |
| 21 | Technical billing contract | `docs/tech/agents/billing-enforcement-semantics.md:51` | Still says zero-balance enforcement blocks at `availableMicrousd <= 0` independent of cap |
| 22 | Operator/config docs | `docs/best-practices/configuration.md`, `config/default.yaml` | Need exact hard-cap semantics documented |

## Decisions

1. **Exact boundary blocks.** Hitting the hard-cap boundary is enough to block. There is no special allowance at the exact boundary.
2. **`null` means unlimited.** No hard cap is enforced when `hardCapMicrousd` is `null`.
3. **All 3 core methods change together.** `computeSpendStatus`, `canSpendNow`, and `reserveCharge` all use the same boundary semantics.
4. **`CanSpendNowResult` exposes `hardCapMicrousd`.** Consumers get the cap value for UI / messaging.
5. **`hardCapMicrousd = 0` is a real cap, not "no cap."** It means paid work is blocked at $0.00. Do not treat `0` like `null` in warnings or docs.
6. **No backward-compatibility constraints.** Prefer semantic clarity and consistency.

## Implementation Changes

### 1. Change `computeSpendStatus()` to exact-boundary blocking

**File:** `packages/db/src/usage-billing-repository.ts`

Replace:

```ts
if (period.hardCapMicrousd != null && netOutOfPocket > period.hardCapMicrousd) {
  return 'hard_limited';
}
```

With:

```ts
if (period.hardCapMicrousd != null && netOutOfPocket >= period.hardCapMicrousd) {
  return 'hard_limited';
}
```

Result:

- `hardCapMicrousd = null` → unlimited
- `hardCapMicrousd = 0`, `balanceMicrousd = 0` → `hard_limited`
- `hardCapMicrousd = 1_000_000`, `balanceMicrousd = -1_000_000` → `hard_limited`

### 2. Change `canSpendNow()` to exact-boundary, cap-aware blocking

**File:** `packages/db/src/usage-billing-repository.ts`

#### Step A — add `hardCapMicrousd` to the SELECT

Add to `select({...})`:

```ts
hardCapMicrousd: billingPeriods.hardCapMicrousd,
```

#### Step B — add `hardCapMicrousd` to `CanSpendNowResult`

```ts
export interface CanSpendNowResult {
  canSpend: boolean;
  availableMicrousd: number;
  hardCapMicrousd: number | null;
  status: AccountStatus;
  reason: 'ok' | 'no_available_credit' | 'hard_limited' | 'suspended';
}
```

#### Step C — replace the available-credit guard

Replace:

```ts
if (availableMicrousd <= 0) {
  return { canSpend: false, availableMicrousd, status: period.status as AccountStatus, reason: 'no_available_credit' };
}
```

With:

```ts
// null cap → unlimited on the credit dimension.
// set cap → block as soon as available credit hits or goes below the cap boundary.
if (period.hardCapMicrousd != null && availableMicrousd <= -period.hardCapMicrousd) {
  return {
    canSpend: false,
    availableMicrousd,
    hardCapMicrousd: period.hardCapMicrousd,
    status: period.status as AccountStatus,
    reason: 'no_available_credit',
  };
}
```

#### Step D — update every return path to include `hardCapMicrousd`

- fresh user / no period → `hardCapMicrousd: null`
- hard_limited / suspended / unknown status / success paths → `period.hardCapMicrousd`

#### Step E — update the method doc comment above `canSpendNow()`

The current comment still says paid work is blocked at `available credit <= 0`. Rewrite it so it matches the canonical rule.

### 3. Change `reserveCharge()` to exact-boundary, cap-aware blocking

**File:** `packages/db/src/usage-billing-repository.ts`

Replace:

```ts
const availableMicrousd = period.balanceMicrousd - period.reservedMicrousd;
if (availableMicrousd < input.amountMicrousd) {
  throw Object.assign(
    new Error(`Insufficient credit: available ${availableMicrousd}, required ${input.amountMicrousd}`),
    { code: 'billing.insufficient_credit' },
  );
}
```

With:

```ts
const availableMicrousd = period.balanceMicrousd - period.reservedMicrousd;
const postReservationAvailableMicrousd = availableMicrousd - input.amountMicrousd;

if (period.hardCapMicrousd != null && postReservationAvailableMicrousd <= -period.hardCapMicrousd) {
  throw Object.assign(
    new Error(
      `Insufficient credit: available ${availableMicrousd}, required ${input.amountMicrousd}, hardCap ${period.hardCapMicrousd}`,
    ),
    { code: 'billing.insufficient_credit' },
  );
}
```

Also update the method comment above `reserveCharge()` so it no longer says it just checks available credit in the old zero-balance sense.

### 4. Update result-shape construction sites

Add `hardCapMicrousd` to all inline / mocked `CanSpendNowResult` objects:

- `packages/db/src/usage-billing-repository.ts` fresh-user return
- `apps/worker/src/agents/agent-session-manager.ts:389`
- `apps/worker/src/usage-billing-service.ts:157`, `162`, `167`
- `apps/worker/src/agent.ts:3042`
- `apps/api/src/routes/chat.test.ts:1110`, `1140`, `1191`
- `apps/worker/src/market-intelligence/assessment-request-service.test.ts:294`, `317`
- `apps/worker/src/usage-billing-service.test.ts` mocked results

### 5. Update billing warning semantics for `hardCapMicrousd = 0`

**File:** `apps/api/src/routes/billing.ts`

Current code treats `0` as "no effective cap":

```ts
const effectiveHardCap = hardCap != null && hardCap > 0 ? hardCap : null;
```

That must change. Under the new rule:

- `null` = no cap
- `0` = real cap at $0.00

Implementation decision for warnings:

1. `null` → no hard-cap warning thresholds
2. `0` → do **not** reuse percentage thresholds mechanically, because 50% / 80% / 100% of zero are meaningless and would all immediately read as reached
3. for `0`, surface a single effective "hard cap reached" state when `netOutOfPocket >= 0`

This keeps the billing page semantically consistent without producing nonsense threshold chips.

### 6. Update authoritative documentation surfaces

#### Public doc

**File:** `apps/web/src/features/public-pages/content/en/docs/agents/billing-limits.md`

Update the hard-cap explanation to state the exact boundary explicitly. Add an example such as:

- "If your hard cap is $1.00, paid usage stops once your balance reaches exactly -$1.00."
- "If you do not set a hard cap, no hard cap is enforced."

Also make sure the doc does not imply that only values below the boundary are blocked.

#### Technical contract

**File:** `docs/tech/agents/billing-enforcement-semantics.md`

Replace the old zero-balance wording:

- remove / rewrite the statement that paid work is blocked when `availableMicrousd <= 0` independent of cap status
- document the new canonical rule for `canSpendNow()` and `reserveCharge()`
- update any examples, tables, and contracts that still assume the old zero-balance rule

#### Operator/config docs

**Files:** `docs/best-practices/configuration.md`, `config/default.yaml`

Document:

- `null` / omitted hard cap means no hard cap
- `0` means block at $0.00
- `100` means block at exactly `-$1.00`

### 7. Update tests

#### A. Repository unit tests: `computeSpendStatus()`

**File:** `packages/db/src/usage-billing-repository.test.ts`

Update existing tests and add:

- exact boundary is now `hard_limited`
- `hardCapMicrousd = 0`, `balanceMicrousd = 0` → `hard_limited`
- `hardCapMicrousd = null`, deep negative balance → `active`

Any existing test that expects "active at exact hard-cap boundary" must be inverted.

#### B. Repository unit tests: `canSpendNow()`

**File:** `packages/db/src/usage-billing-repository.test.ts`

Update mock SELECT rows to include `hardCapMicrousd`.

Required tests:

- blocks when balance hits exact hard-cap boundary
- blocks when balance is beyond hard-cap boundary
- allows when balance is negative but still above boundary
- allows unlimited when `hardCapMicrousd = null`
- blocks at $0.00 when `hardCapMicrousd = 0`

#### C. Repository unit tests: `reserveCharge()`

Direct tests are required. Do **not** leave this conditional.

Add new repository tests covering:

- reservation blocked when post-reservation available credit hits exact boundary
- reservation blocked when post-reservation available credit goes beyond boundary
- reservation allowed when post-reservation available credit stays above boundary
- reservation allowed when `hardCapMicrousd = null`
- reservation blocked at $0.00 when `hardCapMicrousd = 0`

#### D. Consumer / integration tests

Update mocks and expectations in:

- `apps/worker/src/usage-billing-service.test.ts`
- `apps/api/src/routes/chat.test.ts`
- `apps/worker/src/market-intelligence/assessment-request-service.test.ts`

Add or update a billing usage-summary test so the warning response for `hardCapMicrousd = 0` follows the new semantics.

#### E. Validation commands

Minimum post-change validation:

```bash
pnpm lint
pnpm --filter @herobids/db run test
pnpm --filter @herobids/worker run test
pnpm --filter @herobids/api run test
```

If package-level test scripts are too broad or unavailable, run the narrowest equivalent test command covering the touched files.

## Edge Cases

| Scenario | Expected behavior |
|----------|-------------------|
| `hardCapMicrousd = null` | Unlimited. No hard-cap enforcement. |
| `hardCapMicrousd = 0`, `balanceMicrousd = 0` | Hard cap reached immediately; paid work blocked. |
| `hardCapMicrousd = 1_000_000`, `balanceMicrousd = -999_999` | Still allowed. |
| `hardCapMicrousd = 1_000_000`, `balanceMicrousd = -1_000_000` | Blocked / hard-limited at exact boundary. |
| `hardCapMicrousd = 1_000_000`, `balanceMicrousd = -1_000_001` | Blocked / hard-limited. |
| reservations present | Use `balanceMicrousd - reservedMicrousd` for `canSpendNow()` and `reserveCharge()` calculations. |
| top-up mid-period | Balance increases and can move the account back above the boundary. |
| plan upgrade changes cap | Reconciled open period must use the new cap on the next read / recompute. |

## Risks / Lacking Aspects To Cover

1. **Runtime/doc drift risk.** The public billing doc and the technical billing semantics doc are authoritative and must be updated in the same change set, not later.
2. **`hardCap = 0` UI semantics.** Threshold-chip behavior must be intentionally designed, not inherited from the old math.
3. **Shape drift risk.** Inline `CanSpendNowResult` objects outside the repository are easy to miss; use TypeScript errors as a checklist, but keep the explicit list above.
4. **Repository test gap.** `reserveCharge()` currently lacks direct repository tests; this plan makes them mandatory.
5. **Comment drift.** Update stale comments around `canSpendNow()`, `reserveCharge()`, and any docs/comments that still describe the old zero-balance-only guard.

## Dependencies

None. Self-contained.

## Related

- `docs/features/2026/08/06/002-zero-balance-billing-enforcement/001-plan.md` — now needs semantic alignment with this plan
- `docs/features/2026/08/06/003-guided-setup-billing-gate/001-plan.md` — consumes `canSpendNow()` and should inherit the updated semantics
- `docs/tech/agents/billing-enforcement-semantics.md` — must be updated in the same implementation change
