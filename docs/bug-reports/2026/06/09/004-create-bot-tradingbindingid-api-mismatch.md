# 004 — Create Bot form sends venueAccountId but API requires tradingBindingId

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-09
- **UAT reference:** I-03

---

## Summary

Clicking "Create Bot" always returned a `400 validation_error` because the web
client was sending `venueAccountId` in the request body while the API schema
(`CreateInstanceSchema`) requires `tradingBindingId`. The schema also uses
`.strict()`, which rejects any unrecognised field, so even the presence of
`venueAccountId` caused the validation to fail.

## Root Cause

The `bots.create` endpoint was refactored (trading-binding migration) to use
`tradingBindingId` as the lookup key for the venue account, but the web client
and the Create Bot modal were never updated. Three layers were stale:

1. `apps/web/src/lib/api-client.ts` — `bots.create` signature had
   `venueAccountId: string` instead of `tradingBindingId: string`.
2. `apps/web/src/features/bots/BotsPage.tsx` — `CreateBotForm` interface and
   initial state used `venueAccountId`, the modal queried venue accounts instead
   of trading bindings, and the mutation sent `venueAccountId`.
3. The submit-guard `disabled={... || !form.venueAccountId}` also referenced the
   stale field, so the button would never disable for the right reason.

## Fix

Three changes across two files:

**`apps/web/src/lib/api-client.ts`**
- Changed `bots.create` parameter from `venueAccountId: string` to
  `tradingBindingId: string`.

**`apps/web/src/features/bots/BotsPage.tsx`**
- Replaced `venueAccounts as venueAccountsApi` + `VenueAccount` imports with
  `capabilities as capabilitiesApi` + `TradingBindingSummary`.
- Replaced `CreateBotForm.venueAccountId` with `CreateBotForm.tradingBindingId`.
- Replaced the venue-accounts query with a trading-bindings query
  (`capabilitiesApi.tradingBindings()`), filtered to active bindings that have a
  resolved `sourceVenueAccountId` (matching the server-side requirement).
- Derived `venue` from `selectedBinding?.provider` instead of `selectedVA?.venue`.
- Updated the mutation to send `tradingBindingId` and derive venue from the
  selected binding.
- Updated the submit guard to `disabled={mutation.isPending || !form.tradingBindingId}`.
- Updated the "Trading binding" dropdown label and the advanced-config placeholder.

## Files Changed

- `apps/web/src/lib/api-client.ts`
- `apps/web/src/features/bots/BotsPage.tsx`

## Verification

- `pnpm lint` passes (no TypeScript errors).
- Modal now shows "Trading binding" selector populated from
  `GET /capabilities/trading/bindings`.
- Venue is derived from the selected binding's `provider` field, matching the
  `venue` field required by `CreateInstanceSchema`.
- Visual verification in browser: modal renders correctly with the trading-binding
  dropdown.

## Regression Tests

Added to `apps/api/src/routes/bots.test.ts`:

> **`returns 400 validation_error when venueAccountId is sent instead of tradingBindingId (bug-2026-06-09-004 regression)`**

Sends the exact payload the broken client was sending (`venueAccountId` without
`tradingBindingId`). Asserts:
- HTTP 400 returned
- `error` field is `validation_error`
- `details` array contains an issue whose `path` includes `tradingBindingId`
  (confirming the schema enforces the required field, not just rejecting the
  unknown one)

The `.strict()` modifier on `CreateInstanceSchema` ensures any future regression
(re-adding `venueAccountId` to the client) would also be caught by the existing
"returns 400 when both tradingBindingId and venueAccountId are provided" test.

---

## Related

- Bug 005 (I-03b) was flagged in the same UAT run as "disabled button renders
  fully green". Computed-style inspection (`window.getComputedStyle`) confirmed
  `opacity: 0.5` is correctly applied. The appearance in JPEG screenshots makes
  the 50 % opacity hard to distinguish visually — no code change required.
