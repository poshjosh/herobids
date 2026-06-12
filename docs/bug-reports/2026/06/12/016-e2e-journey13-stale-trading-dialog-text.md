# 016 — Journey 13 E2E test uses stale UI text after form was renamed to "Add trading connection"

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-12
- **Summary:** `journeys/13-mc-setup-card.spec.ts` failed because the connection setup dialog opened from Mission Control now renders as "Add trading connection" (the trading-specific variant), not "Add provider connection" (the generic variant) as the test expected.

## Root Cause

The `SetupForm` component was updated to use a trading-specific title and submit button ("Add trading connection") when opened from Mission Control, along with trading-specific placeholder text ("e.g. hyperliquid, bybit, 1inch" / "e.g. My Hyperliquid account"). The test still asserted against the old generic text:
- Dialog title: `"Add provider connection"` → now `"Add trading connection"`
- Provider placeholder: `"e.g. hyperliquid, gmail, n8n"` → now `"e.g. hyperliquid, bybit, 1inch"`
- Label placeholder: `"e.g. My Gmail inbox"` → now `"e.g. My Hyperliquid account"`
- Submit button: `"Add provider connection"` → now `"Add trading connection"`

## Fix

Updated the three stale assertions in `13-mc-setup-card.spec.ts` to match the current UI copy (as already used in the passing `14-create-agent-setup-escape-hatch.spec.ts`).

## Files Changed

- `tests/e2e/journeys/13-mc-setup-card.spec.ts`

## Verification

Journey 13 passes. All 18 E2E tests pass.
