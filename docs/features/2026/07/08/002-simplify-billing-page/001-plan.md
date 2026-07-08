# Plan: Simplify Billing Page — AI Usage Credit View

**Status:** Draft
**Created:** 2026-07-07

---

## Problem

The billing page (`apps/web/src/features/billing/BillingPage.tsx`) exposes too much accounting machinery to the user. The "AI Usage — Current Period" card shows four fields (Account Status, Usage Charges, Credits Applied, Balance) plus an optional Hard Cap — but only one of these answers the question the user is actually asking:

> *"How much AI usage credit do I have left?"*

The other fields are internal ledger artifacts that confuse users:

- **"Credits Applied"** is an internal tracking field — how much of the pre-paid balance has been consumed by usage. Users don't need to see this; they need to see what's left.
- **"Balance"** is the right number but lacks context — it silently combines included plan credits + top-ups. A user who subscribes to Pro ($20 included credit) and buys a $5 top-up sees $25 and wonders: "I only topped up $5, where did the extra $20 come from?"
- **"Hard Cap"** is irrelevant for most users (it's null unless explicitly set).
- **"Account Status"** is important but over-emphasized as a separate field — it should be a badge on the credit gauge.

Additionally, the page is a long vertical scroll of 13 always-visible cards. Much of what's below the fold (ledger, usage events, billing periods, meter/agent breakdowns) is power-user debugging data that should be collapsed by default.

## Goal

A billing page where the user instantly understands their credit situation at a glance:

| User intent | Entry point | Result |
|---|---|---|
| How much credit do I have left? | Glance at the gauge | One number + progress bar |
| Am I about to be cut off? | Status badge on the gauge | Active / Warning / Paused |
| What am I paying for? | "Included + top-ups" subtext | Clear breakdown |
| How much did I use this month? | "Used" subtext below gauge | Dollar amount |
| I need more credit | "Buy Top-up" button | Checkout flow |
| I want to see the details | "View details" toggle | Ledger + events + breakdowns |

## Key Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Frontend only.** No backend changes. | The `/billing/usage-summary` API already returns all needed data (`balanceMicrousd`, `usageChargeMicrousd`, `includedCreditMicrousd`, `creditAppliedMicrousd`). Simplification is purely presentation. |
| 2 | **Replace stat grid with credit gauge.** | A visual progress bar communicates remaining credit faster than four numeric fields. |
| 3 | **Remove "Credits Applied" from main view.** | It's an internal accounting artifact. Move to the ledger detail section for power users. |
| 4 | **Add "included + top-ups" subtext.** | Solves the "where did the extra $20 come from?" confusion. Computed as `includedCreditMicrousd + (balanceMicrousd - includedCreditMicrousd + creditAppliedMicrousd - usageChargeMicrousd)` or simply expose top-up totals from the ledger. For v1, show `balanceMicrousd + usageChargeMicrousd` as "Total credit this period" with a breakdown: included from plan + top-ups = used + remaining. |
| 5 | **Collapse detail sections behind a toggle.** | The current page has 13 always-visible cards. Spending controls, ledger, usage events, and breakdowns should be behind a "Details" expandable section. The default view should be: credit gauge + subscription info + top-up button. |
| 6 | **Move spend caps to details.** | Setting soft/hard caps is a rare operation. It doesn't need prime real estate. |
| 7 | **Do NOT change the data model or API.** | This is a pure UI refactor. No migration, no API version bump. |

## Implementation Plan

### Phase 0 — Prerequisite: Add `topUpTotalMicrousd` to API response (optional, low-effort)

**Files:**
- `apps/api/src/routes/billing.ts`
- `packages/db/src/usage-billing-repository.ts`

**Changes:**
- The `UsagePeriodSummary` currently has `includedCreditMicrousd` but no explicit `topUpTotalMicrousd`. The frontend can derive it from `balanceMicrousd + creditAppliedMicrousd + usageChargeMicrousd - includedCreditMicrousd`, but this is fragile.
- Option A (preferred): Add `topUpTotalMicrousd` to the `getUsageSummary` query by summing `top_up_credit` ledger entries for the period. Return it in `UsagePeriodSummary`.
- Option B: Skip this and compute on the frontend. The formula `Math.max(0, balanceMicrousd + usageChargeMicrousd - includedCreditMicrousd)` is correct as long as no manual adjustments exist.
- **Decision: Go with Option B for v1** to keep this frontend-only. We can add the field later if needed.

### Phase 1 — Create the credit gauge component **[DONE]**

**Files:**
- `apps/web/src/features/billing/BillingPage.tsx` (inline or extracted)

**Changes:**
- Extract a `CreditGauge` inline component that takes:
  - `balanceMicrousd: number` — remaining credit
  - `totalCreditMicrousd: number` — included + top-ups (initial balance)
  - `usageChargeMicrousd: number` — used this period
  - `includedCreditMicrousd: number` — included from plan
  - `status: AccountStatus`
- Renders:
  - A horizontal progress bar: filled portion = `balanceMicrousd / totalCreditMicrousd`, colored by status (green → yellow → red)
  - Centered or right-aligned: `$X.XX left` in large text
  - Below the bar: `$X.XX used this month`
  - Subtext: `$X.XX included with Pro plan + $X.XX top-ups`
  - Status badge (active / warning / paused) as a colored pill next to the plan name
- The gauge replaces the current 4–5 field stat grid entirely.
- When `balanceMicrousd <= 0`, the bar is empty and the text shows out-of-pocket spend: `$X.XX over limit`

### Phase 2 — Reorganize card layout **[DONE]**

**Files:**
- `apps/web/src/features/billing/BillingPage.tsx`

**Changes:**

**Default view (always visible):**
1. **Credit Gauge card** — the new `CreditGauge` component (replaces current "AI Usage — Current Period" card)
2. **Top-up row** — inside the gauge card's footer: dropdown + "Buy Top-up" button. Remove the separate "Spend Controls" card.
3. **Subscription cards** — unchanged (Current Plan, Subscription status, Change Plan)

**Collapsible "Details" section** (hidden by default, toggled via a "View details ▸" / "Hide details ▾" button below the gauge card):
4. **Spend controls** — soft/hard cap inputs (moved from separate card)
5. **Usage by Meter** table
6. **Usage by Agent** table
7. **Billing Ledger** table
8. **Usage Events** table
9. **Billing Periods** table

**Removed entirely from the page:**
- The old four-field stat grid (Account Status, Usage Charges, Credits Applied, Balance, Hard Cap) — replaced by the gauge
- The standalone "Spend Controls" card — merged into details
- The standalone "Usage Filters" card — filters stay above their respective tables inside the details section

### Phase 3 — i18n keys **[DONE]**

**Keys to add:**
```
billing.usage.creditLeft          "left"
billing.usage.usedThisMonth       "used this month"
billing.usage.includedWithPlan    "{planName} plan included"
billing.usage.topUps              "top-ups"
billing.usage.overLimit           "over limit"
billing.usage.viewDetails         "View details"
billing.usage.hideDetails         "Hide details"
billing.usage.totalCredit         "Total credit"
```

**Keys to remove/review:**
- `billing.usage.emptyAccount` — keep
- `billing.usage.emptyPeriod` — keep

### Phase 4 — Cleanup **[DONE]**

**Files:**
- `apps/web/src/features/billing/BillingPage.tsx`

**Changes:**
- Remove unused `usageBreakdownQuery` if the meter/agent breakdowns are moved to details (they're still needed, just conditionally rendered)
- Remove `usageEventOffset`, meter/agent/session/period filter state if they're only relevant inside the collapsed details (keep them, just gate their queries behind the expanded state)
- Consider extracting the details section into a separate `BillingDetails` component to reduce the monolithic file size (~890 lines currently)

## Architecture Impact

| Layer | Component | Change |
|---|---|---|
| Web — features | `BillingPage.tsx` | Major refactor: replace stat grid with gauge, add collapse toggle, reorganize cards |
| Web — i18n | `en.json` (or equivalent) | Add ~7 new keys |
| API — routes | `billing.ts` | **No change** |
| DB — repository | `usage-billing-repository.ts` | **No change** |

## Acceptance Criteria

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] Billing page loads and shows credit gauge instead of four-field stat grid
- [ ] Credit gauge shows: progress bar, "$X.XX left", "used this month", plan + top-up breakdown
- [ ] Status badge is visible and color-coded (green/yellow/red)
- [ ] When balance is positive, gauge bar is filled proportionally
- [ ] When balance is zero or negative, gauge shows "over limit" state
- [ ] "Buy Top-up" button is reachable without scrolling past detail tables
- [ ] Detail sections (ledger, events, periods, breakdowns) are hidden by default
- [ ] "View details" toggle reveals detail sections; "Hide details" collapses them
- [ ] Spend cap controls are inside the details section (not a standalone card)
- [ ] Subscription cards (Current Plan, Change Plan) remain unchanged and functional
- [ ] Top-up checkout flow still works (redirects to provider)
- [ ] Page is significantly shorter in default view (no more long scroll)
- [ ] No backend API change required
- [ ] No database migration required

---

## Outstanding Issues

### [Phase 1] CreditGauge Component

| Severity | # | Issue | Resolution |
|---|---|---|---|
| MEDIUM | M1 | Hardcoded `'Pro plan'` fallback in `CreditGauge` — misleading for users on Basic/Enterprise/custom plans. | Fix in Phase 3 when adding i18n keys: use `intl.formatMessage()` or blank out instead of assuming "Pro". |
| MEDIUM | M2 | `totalCreditMicrousd = balanceMicrousd + usageChargeMicrousd` derivation is fragile when manual adjustments/reversals exist in ledger. | Known limitation per plan Decision #2/Option B. File follow-up task for API-side `topUpTotalMicrousd`. |
| LOW | L1 | All user-facing strings are hardcoded English — expected, Phase 3 handles i18n. | No action (Phase 3). |
| LOW | L2 | `status` prop typed as `string` instead of union type. | Consider using `AccountStatus` type if available. |
| LOW | L3 | `$0.0000 over limit` when balance is exactly $0 (technically "at limit"). | Minor UX — could differentiate "No credit remaining" vs "over limit". |
| LOW | L4 | Bar color uses percentage not account status (plan says "colored by status"). | Reasonable interpretation; status badge already carries color. |
| LOW | L5 | No text truncation on long `planName`. | Add `text-overflow: ellipsis` if needed. |
| LOW | L6 | Status badge next to dollar amount instead of plan name. | Cosmetic, functional equivalence. |
| LOW | L7 | `CreditGauge` not wrapped in `React.memo`. | Low impact for component this simple.

### [Phase 2] Card Layout Reorganization

| Severity | # | Issue | Resolution |
|---|---|---|---|
| MEDIUM | M1 | Orphaned i18n key `billing.usage.noAccountControls` — the `!usageAccount` code path is now unreachable. | Clean up in Phase 3/4. Key remains in locale files but is dead code. |
| MEDIUM | M2 | All detail queries fire unconditionally on page load even when details collapsed. | Address in Phase 4 (add `enabled: showDetails` to queries). |
| MEDIUM | M3 | Top-up row renders even without `currentPeriod` (gated on `usageAccount` only). | Minor UX inconsistency; align in follow-up. |
| LOW | L1 | Hardcoded English strings from Phase 2 additions (toggle labels, section headers). | Handled in Phase 3. |
| LOW | L2 | Spend Controls/Usage Filters have no visual container in details section, creating inconsistency with carded tables below. | Consider wrapping in shared `<Card>` or adding separator. |

### [Phase 3] i18n Keys

| Severity | # | Issue | Resolution |
|---|---|---|---|
| MEDIUM | N1-N23 | ~24 hardcoded English strings remain in details section, tables, empty states, pagination, filters, and `LEDGER_ENTRY_TYPE_LABELS`. These were pre-existing and not in Phase 3 scope. | File follow-up task for full i18n pass on detail sections (Phase 4 or separate). |
| LOW | N24 | `LEDGER_ENTRY_TYPE_LABELS` static map has 8 hardcoded English labels. | Convert to i18n keys or `intl.formatMessage()` at render time. |

### [Phase 4] Cleanup

| Severity | # | Issue | Resolution |
|---|---|---|---|
| MEDIUM | M1 | Spend Controls + Usage Filters lack `<Card>` wrapper in BillingDetails, creating visual inconsistency with carded tables. | Pre-existing; consider follow-up. |
| MEDIUM | M2 | ~10 hardcoded English strings remain in BillingDetails (section headers, filters, empty states). | Pre-existing from Phase 3; file follow-up i18n pass. |
| LOW | L1 | `formatMicrousd` should live in shared `lib/formatting.js`. | Moved to BillingDetails.tsx and exported; shared lib extraction in follow-up. |
| LOW | L2 | `BillingDetailsProps` has 30+ props — consider grouping. | Refactor in follow-up pass. |
