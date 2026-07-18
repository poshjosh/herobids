# Bug Report: ProviderSetupForm defaults to no provider selected, hiding "Add secret" in general setup

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-18
- **Summary:** `ProviderSetupForm` initialised `providerChoice` to `''` for all setup modes and relied on a `useEffect` to pick a default, so the very first render (and any render before effects commit) showed neither a known provider's credential fields nor the custom "Add secret" UI.

## Root Cause

Commit `0dedf7bf` ("Improve ux") changed `providerChoice`'s initial state from
`defaultCapability === 'trading' ? '' : CUSTOM_PROVIDER_OPTION` to always `''`,
moving default-provider selection entirely into a `useEffect`. Because React
effects don't run during the first synchronous render (notably
`renderToStaticMarkup`, but also the initial paint before hydration commits),
`providerChoice` stayed `''` on that first render. With `providerChoice === ''`,
`isCustomProvider` was `false` and `selectedProvider` was `undefined`, so the
Secrets section rendered an empty container — no per-field inputs and no
"Add secret" button — until the effect fired.

## Fix

Replaced the effect-driven default with a value derived synchronously during
render (`defaultProviderChoice` / `effectiveProviderChoice`):
- Trading setups (`defaultCapability === 'trading'`) default to the first
  trading provider once the catalog is loaded (falling back to the custom
  option if none exist).
- General setups default to the custom provider option, restoring prior
  behaviour.

`selectedProvider`, `isOAuthProvider`, `canGenerateWallet`, `isCustomProvider`,
`effectiveProvider`, and the `<select>`'s controlled `value` now all read from
`effectiveProviderChoice` so the correct UI is present on the very first
render. A `useEffect` still commits the derived default into `providerChoice`
state once known, so the `<select>` remains a normal controlled input for
subsequent explicit user changes.

## Files Changed

- `apps/web/src/features/setup/ProviderSetupForm.tsx`

## Verification

- `pnpm --filter @herobids/web exec vitest run src/features/setup/provider-setup-form.test.tsx` — 36/36 passed (previously 1 failing).
- `pnpm lint` — passed.
- `pnpm test` (full suite) — 294 passed | 23 skipped, 0 failing (previously 1 failing).
- Re-ran `pnpm test` followed by the filtered `manage_bot create_and_start.*LLM inheritance` suite back-to-back (mirroring `run-all-tests.sh` steps 1 and 1b) — both passed cleanly with no `EPIPE`/unhandled rejection, confirming the previously reported EPIPE was a downstream flake of the first failing run rather than a separate defect.
