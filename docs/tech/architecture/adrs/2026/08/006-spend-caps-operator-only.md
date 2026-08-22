# ADR 006: Spend Caps Are Operator-Only

**Date:** 2026-08-10
**Status:** Accepted

## Context

The Billing page (`BillingDetails.tsx`) exposes soft-cap and hard-cap
inputs to all users via `POST /billing/spend-caps`. In practice, user-set
caps are ephemeral: the worker reconciliation loop in
`agent-session-manager.ts` passes plan-derived caps to
`getOrCreateBillingAccountForUser` and `getOrCreateOpenPeriod` on every
session start, unconditionally overwriting any user-set values on both the
account and the open billing period.

This creates a misleading UX: a user can set a higher hard cap, see it
reflected in the UI, and believe they have more headroom — only to have it
reset to the plan default the next time their agent starts.

The `entitlement-sync.ts` path (plan upgrades) preserves user-set caps via
`resolveCapForUpgrade`, but the worker session-start path does not use
that helper. This inconsistency means caps survive a plan change but
not a session restart.

## Decision

**Spend caps are an operator-level control.** They define how much a user
can overspend on platform resources beyond their included credits. The
user has no incentive to self-limit — the operator bears the cost risk.

The Billing page spend-cap inputs are **hidden from non-admin users**.

- The plan tier (`config/default.yaml → plans.<id>.usage`) remains the
  authoritative source for caps.
- Admin users may still set caps via the Billing page for operational
  overrides (support, incident response, temporary raises for paying
  users).
- The `POST /billing/spend-caps` endpoint is unchanged — enforcement
  happens at the UI layer via an admin-only gating prop.

## Consequences

- Non-admin users will no longer see the spend-cap input fields on the
  Billing page. The current-period caps will still be displayed
  read-only (they reflect the plan tier's effective caps).
- The `isAdmin` prop already flows into `BillingDetails` for ledger
  visibility; the same prop gates the spend-cap controls.
- No backend changes required. The worker reconciliation behaviour
  (plan defaults overwriting user caps) becomes the intended norm rather
  than a bug — admin overrides are explicitly temporary and session-scoped.
