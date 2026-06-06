# Bug Report: E2E Journey Tests Used Ambiguous Locators (Strict Mode Violations)

**Date**: 2026-06-06
**Severity**: High (blocked 5 of 6 remaining E2E journeys after login was fixed)
**Component**: `tests/e2e/journeys/` (01, 02, 04, 05)

## Summary

Multiple Playwright journey tests used locators that matched more than one element, causing "strict mode violation" errors. Playwright strict mode raises an error when a locator resolves to multiple elements unless explicitly scoped.

## Instances

### Journey 01 — `getByText(/agents|AI agents/i)` (3 matches)
The agents page has "Agents" in the sidebar nav, "AI Agents" as the page heading, and "No agents yet" in the empty state — all matching the regex. The test intended to verify the page heading.

**Fix**: `page.getByRole('heading', { name: /AI Agents/i })`

### Journey 01 — `getByRole('button', { name: /new agent|create agent/i })` (2 matches)
Both the header "New Agent" button and the empty-state "Create Agent" button matched the regex.

**Fix**: `.first()` to target the primary header button (also fixed in `helpers.ts`).

### Journey 01 — `.or()` agent card locator (2 matches)
`locator('.agent-card').or(getByText(/BTC drops 5/i))` resolved to both the card container and the inner text node.

**Fix**: `.first()` on the `.or()` result.

### Journey 02 — `getByRole('button', { name: /create account|sign in|log in/i })` (2 matches)
The submit button ("Create account") and the toggle link button ("Already have an account? Sign in") both matched.

**Fix**: `.first()` to target the submit button.

### Journey 04 — `getByText(/Runtime Health/i)` (2 matches)
The agent was named "Runtime Health Agent" — its `<h1>` title contained "Runtime Health", matching the same regex as the `<h3>` section card heading.

**Fix**: `page.getByRole('heading', { name: 'Runtime Health', exact: true })`

### Journeys 04 & 05 — `getByText(/starting/i)` (2 matches)
The status badge "starting" appeared twice in the DOM (likely once in the page heading area and once in the runtime health card).

**Fix**: `.first()` to target the first occurrence.

## Root Cause

Tests were written with overly broad regex locators that did not account for the actual page structure, where the same text appears in multiple contexts (navigation, headings, content cards, etc.).

## Files Changed

- `tests/e2e/journeys/01-signup-create-agent.spec.ts`
- `tests/e2e/journeys/02-agent-decision-visible.spec.ts`
- `tests/e2e/journeys/04-safety-alert-visible.spec.ts`
- `tests/e2e/journeys/05-pause-resume-agent.spec.ts`
- `tests/e2e/helpers.ts`
