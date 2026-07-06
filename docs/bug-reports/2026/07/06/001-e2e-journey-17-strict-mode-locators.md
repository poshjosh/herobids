# Bug Report: 001-e2e-journey-17-strict-mode-locators.md

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-06
- **Summary:** E2E Journey 17 tests fail with strict mode violations — `getByText('Bots')` and `getByText('Create Bot')` match multiple elements.

## Root Cause

Playwright's `getByText()` locator matched 5 elements each for "Bots" and "Create Bot" on the page, violating strict mode (single-element expectation). The locators were too broad.

- `getByText('Bots')` matched: nav link, heading, subtitle, empty state text, empty state description
- `getByText('Create Bot')` matched: header CTA button, empty state CTA button, dialog title div, dialog submit button, dialog disabled button

Additionally, the dialog title is rendered as a `<div>` in the `Modal` component, not as a heading element. Using `getByRole('heading')` failed because no `<h1>`-`<h6>` exists for the dialog title.

## Fix

1. Replaced `page.getByText('Bots')` with `page.getByRole('heading', { name: 'Bots' })` for the page title assertion.
2. Replaced `page.getByText('Create Bot')` with `page.getByRole('dialog').getByText('Create Bot').first()` for modal visibility assertions, scoping to the dialog context.

## Files Changed

- `tests/e2e/journeys/17-create-bot-modal.spec.ts` — Updated 3 locator assertions

## Verification

- `scripts/shell/tests/run-all-tests.sh --e2e`: E2E tests pass with 17 passed, 0 failed.
