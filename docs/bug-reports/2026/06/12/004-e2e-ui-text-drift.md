# 004 — E2E tests failing after UI text/label changes

**Date:** 2026-06-12  
**Severity:** High (blocks E2E suite)  
**Affected files:**
- `tests/e2e/helpers.ts`
- `tests/e2e/journeys/01-signup-create-agent.spec.ts`
- `tests/e2e/journeys/03-agent-send-message.spec.ts`
- `tests/e2e/journeys/05-pause-resume-agent.spec.ts`
- `tests/e2e/journeys/07-mission-control-renders.spec.ts`
- `tests/e2e/journeys/12-locale-switch-renders-hindi.spec.ts`
- `tests/e2e/journeys/13-mc-setup-card.spec.ts`
- `tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`

## Symptoms

Multiple E2E journeys failed because Playwright locators matched against stale UI strings that no longer existed in the running application.

## Root Cause

UI-facing strings in `apps/web/src/app/i18n/locales/en.ts` (and corresponding component code) were updated as part of feature work but the E2E tests were not updated alongside them. The following specific drifts were found:

| Old string (in tests) | New string (in app) |
|---|---|
| `"New agent"` / `"Create agent"` button | `"New AI agent"` / `"Create AI agent"` |
| `"Protocol Activity"` tab label | `"Activity Timeline"` |
| `"No protocol messages yet"` empty state | `"No activity recorded yet"` |
| `/stopped/i` (2 elements, strict mode violation) | `'stopped'` exact match on `.first()` |
| `"Your agents"` section heading | `"Your AI agents"` |
| `"No agents yet"` empty state | `"No AI agents yet"` |
| Hindi `'नया एजेंट'` button | `'नया AI एजेंट'` |
| `"Quick trading setup"` card title | `"Quick AI agent connect"` |
| `"Add trading provider"` CTA | `"Add provider connection"` |
| `"Set up trading provider"` submit | `"Add provider connection"` |
| `getByRole('heading')` inside modal | Modal title is a `<div>`, not a heading; use `locator('div').filter(...)` |
| `"Execution mode"` on agent detail | Only present for trading-capable agents; `"AI agent status"` always present |
| Provider form placeholder `'e.g. hyperliquid, bybit, 1inch'` | `'e.g. hyperliquid, gmail, n8n'` (general form) |
| Label placeholder `'e.g. My Hyperliquid account'` | `'e.g. My Gmail inbox'` (general form) |
| `createAgent()` missing name field fill | Name input must be filled before goal to enable Review button |
| Submit button ambiguous (`Add provider connection` matches CTA + submit) | Scope to `getByRole('dialog').getByRole('button', ...)` |

## Fix Applied

Updated all affected E2E test files and `helpers.ts` to match current UI strings, selectors, and form interaction order.
