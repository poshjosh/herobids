# 007 — Mission Control setup does not create trading binding

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-12
- **Summary:** Adding a provider connection via the Mission Control page "Set up trading" form never creates a trading binding. After page refresh the connection appears gone (because only the ephemeral success banner was showing) and the binding is absent from the agent creation form's binding selector.

## Root Cause

`MissionControlPage.tsx` renders `<ProviderSetupForm>` without the `defaultCapability="trading"` prop:

```tsx
// Before fix
<ProviderSetupForm
  onClose={...}
  onSuccess={...}
/>
```

`ProviderSetupForm` forwards the `capability` field to `POST /setup/provider-link`. When `defaultCapability` is `undefined` the field is `undefined` and omitted from the request body. The API handler only provisions a `venueAccount` + `tradingBinding` when `capability === 'trading'`, so without the prop only a credential and a connection are created — no trading binding.

The shell script (`scripts/shell/ops/quick-setup.sh`) hardcodes `--arg capability trading` in its guided-mode `jq` payload, which is why that path works correctly.

The `AgentsPage.tsx` inline setup path already passes `defaultCapability="trading"` (line 253) and was unaffected.

## Fix

Added `defaultCapability="trading"` to the `ProviderSetupForm` usage in `MissionControlPage.tsx`:

```tsx
// After fix
<ProviderSetupForm
  defaultCapability="trading"
  onClose={...}
  onSuccess={...}
/>
```

## Files Changed

- `apps/web/src/features/mission-control/MissionControlPage.tsx`

## Verification

- `GET /capabilities/trading/bindings` now returns the newly created binding after submitting the Mission Control setup form.
- The binding appears in the agent creation form's trading binding selector without requiring the shell script.
- No TypeScript errors introduced.

## Tests Added

- `apps/web/src/features/mission-control/MissionControlPage.setup.test.tsx` (new) — Renders `ProviderSetupForm` with the exact props `MissionControlPage` passes (`defaultCapability="trading"`) and asserts trading-mode UI (title, submit label, provider suggestions). Also renders without the prop to confirm the non-trading baseline, ensuring a future removal of `defaultCapability` would break these tests.
- `apps/web/src/features/setup/provider-setup-form.test.tsx` (extended) — New `capability field in setup payload` section with pure-logic tests verifying that the JSON request body includes `capability: 'trading'` when `defaultCapability` is `'trading'` and omits the field when `defaultCapability` is `undefined`.
