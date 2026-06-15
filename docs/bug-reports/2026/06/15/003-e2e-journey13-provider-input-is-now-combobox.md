# Bug 2026-06-15-003: E2E Journey 13 — "Add trading connection" modal provider field is now a combobox, not a text input

## Date
2026-06-15

## Severity
LOW — E2E test/UI mismatch; no product regression.

## Summary
Journey 13 (`13-mc-setup-card.spec.ts`) times out at `page.getByPlaceholder('e.g. hyperliquid, bybit, 1inch').fill('hyperliquid')`. The "Add trading connection" modal has changed its provider field from a free-text `<input>` (with that placeholder) to a `<combobox>` (native `<select>`) with preset options: Hyperliquid, Bybit, 1inch, Jupiter.

## Root Cause
The product UI was updated so the provider field in the connection setup modal is a `<select>` element with fixed options rather than a free-text input. The test was written against the old text-input API.

**Page snapshot (at point of failure):**
```yaml
- dialog:
  - "Add trading connection"
  - combobox:             ← was a text input with placeholder 'e.g. hyperliquid, bybit, 1inch'
    - option "Hyperliquid" [selected]
    - option "Bybit"
    - option "1inch"
    - option "Jupiter"
  - textbox "e.g. My Hyperliquid account"
```

## Steps to Reproduce
Run `pnpm exec playwright test journeys/13-mc-setup-card.spec.ts`.

## Expected
Able to fill in provider name via text input.

## Actual
`locator.fill` times out because the placeholder text element does not exist; provider is now a combobox.

## Fix Required
Update `tests/e2e/journeys/13-mc-setup-card.spec.ts` to use `selectOption` instead of `fill` for the provider field:

```ts
// Old (broken):
await page.getByPlaceholder('e.g. hyperliquid, bybit, 1inch').fill('hyperliquid');

// New:
await page.getByRole('combobox').selectOption('Hyperliquid');
```

Also ensure any downstream assertions about secret field count still match the combobox-driven template population.

## Files
- `tests/e2e/journeys/13-mc-setup-card.spec.ts`
