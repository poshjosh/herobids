# Bug Report 018 — E2E createAgent helper fails with Trading preset (capital field)

- **Status:** CLOSED
- **Severity:** Low
- **Date:** 2026-06-23
- **Summary:** The E2E `createAgent` helper in `tests/e2e/helpers.ts` does not fill the required Capital field when the Trading preset (or trading-capability skills) is active, causing 3 E2E tests to timeout at `waitForURL` after clicking the Review/Create buttons.
- **Root Cause:** 
  1. The `createAgent` helper defaults to the Trading preset when no preset is specified, which shows a required "Capital (USD)" field.
  2. The Capital `<input>` has no explicit `type="text"` attribute, so `input[type="text"]` CSS selector does not match it.
  3. Even when the capital field is filled programmatically, React's batched state updates mean the form validation still sees the old empty value when the Review button is clicked.
- **Fix:** 
  - Test 4 (`04-safety-alert-visible.spec.ts`): Changed `{ skillIds: [] }` to `{ preset: 'general' }` to avoid Trading preset.
  - Tests 8/9 (`07-mission-control-renders.spec.ts`, `08-mission-control-capability-reflects.spec.ts`): Changed to create agents via API (`POST /api/agents`) instead of using the `createAgent` UI helper, bypassing the Trading preset form flow entirely.
- **Files Changed:**
  - `tests/e2e/journeys/04-safety-alert-visible.spec.ts` — changed preset from `skillIds: []` to `preset: 'general'`
  - `tests/e2e/journeys/07-mission-control-renders.spec.ts` — replaced `createAgent()` with API-based agent creation
  - `tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts` — replaced `createAgent()` with API-based agent creation
- **Verification:** Full E2E suite ran: 19/19 passed (previously 16/19 with 3 failures).
- **Note:** The underlying React state timing issue (programmatic fill + immediate form validation) should be investigated separately if the Trading preset UI flow needs to be tested via E2E in the future.
