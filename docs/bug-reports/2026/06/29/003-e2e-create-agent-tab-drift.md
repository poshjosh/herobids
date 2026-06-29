# E2E test `14-create-agent-setup-escape-hatch` — UI layout drift

**Date:** 2026-06-29
**Severity:** MEDIUM
**Status:** Open

## Summary

E2E test `journeys/14-create-agent-setup-escape-hatch.spec.ts:87` fails because the "No active platform links yet" text is no longer visible in the "AI Configuration" tab. The test expects to find this text after switching to the AI Configuration tab during agent creation, but the UI layout has changed — the trading setup section (connection slot with no-connections message) may have moved to a different tab (e.g., "Trading Setup") or is rendered outside the tab structure entirely.

## Error

```
Error: expect(locator).toBeVisible() failed
Locator: getByText(/No active platform links yet/i)
Expected: visible
Timeout: 8000ms
```

## Root cause

The `connectionSlot` UI component (which renders the "No active platform links yet" message and "Set up trading now" button) was previously rendered inside the AI Configuration tab. The UI was refactored — likely as part of the `connections`/`bindings` merge — and the trading setup section moved to a dedicated "Trading Setup" tab or is now part of the main form layout.

The i18n key `agents.create.noConnections` is still used in `AgentsPage.tsx:615` and `EditAgentModal.tsx:412`, but the tab structure may have changed.

## Recommended fix

1. Update the E2E test to locate the "No active platform links yet" text in the correct tab/section
2. If the text now lives under "Trading Setup" tab, update the test to navigate there instead of "AI Configuration"
