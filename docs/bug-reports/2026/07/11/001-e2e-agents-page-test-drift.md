# Bug Report: E2E agents-page expectations drifted from current UI

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-11
- **Summary:** Two Playwright journeys were asserting stale agents-page behavior that no longer matches the current UI.

## Root Cause

The empty-state agents journey still expected a named `region` for "Your AI agents", but the current page renders the empty state without that landmark. The quick-setup journey also assumed the "Connect AI agent to external platform" card is visible for a fresh account, but the current product intentionally hides that card until at least one agent exists.

## Fix

Updated the affected Playwright specs to match the current behavior:

- Removed the stale region assertion from the empty-state agents-page test.
- Created one starter agent before opening the quick-setup card flow, so the setup-card journey exercises the current UI path.

## Files Changed

- [tests/e2e/journeys/07-agents-page-renders.spec.ts](../../../../../tests/e2e/journeys/07-agents-page-renders.spec.ts)
- [tests/e2e/journeys/13-agents-setup-card.spec.ts](../../../../../tests/e2e/journeys/13-agents-setup-card.spec.ts)

## Verification

- `pnpm lint` passed.
- A targeted Playwright run was attempted, but it could not connect to the local app server on `http://localhost:5173`, so full end-to-end confirmation still requires the web stack to be running.