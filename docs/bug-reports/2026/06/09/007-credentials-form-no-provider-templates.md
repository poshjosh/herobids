# Bug Report — Credentials Form Missing Provider Secret Templates (C-03)

- **Status:** CLOSED
- **Tests:** `apps/web/src/features/credentials/credentials-templates.test.ts` — validates all `PROVIDER_TEMPLATES` entries (hyperliquid, jupiter, bybit, 1inch, telegram) and the `applyProviderTemplate` logic: applies keys when values are empty; skips when values present; case-insensitive; returns null for unknown providers
- **Severity:** Medium
- **Date:** 2026-06-09
- **Summary:** The "Add provider credential" form in `/credentials` had no provider-specific secret templates. Regardless of which provider was typed (e.g. `hyperliquid`, `bybit`, `telegram`), the secret fields always showed generic "Secret name" / "Secret value" placeholders, leaving users to guess which secret keys the provider requires.

## Root Cause

The `CreateCredentialModal` component in `CredentialsPage.tsx` initialised `secretEntries` with a single blank entry and never updated based on the selected provider. There was no template system — `PROVIDER_SUGGESTIONS` existed for the datalist but only provided autocomplete suggestions, not field templates.

## Fix

Added a `PROVIDER_TEMPLATES` map and an `applyProviderTemplate` function:

```ts
const PROVIDER_TEMPLATES: Record<string, string[]> = {
  hyperliquid: ['privateKey'],
  jupiter: ['privateKey'],
  bybit: ['apiKey', 'apiSecret'],
  '1inch': ['apiKey'],
  telegram: ['botToken'],
};
```

When the user types or selects a provider that matches a known template:
- If no secret values have been entered yet, the secret key fields are auto-populated with the template keys
- Existing values are preserved (template only applies when all values are blank, to avoid overwriting user input)
- The user can still manually add/remove/rename keys

The provider input's `onChange` handler was updated from calling `setProvider` directly to calling `applyProviderTemplate`.

## Files Changed

- `apps/web/src/features/credentials/CredentialsPage.tsx`
  - Added `PROVIDER_TEMPLATES` constant after `PROVIDER_SUGGESTIONS`
  - Added `applyProviderTemplate` function in `CreateCredentialModal`
  - Wired `applyProviderTemplate` to provider `<input>` `onChange`

## Verification

1. Navigate to `/credentials`, click "Add provider credential"
2. Type `hyperliquid` → secret key field auto-fills with `privateKey` ✅
3. Cancel; open again, type `bybit` → two entries appear: `apiKey` and `apiSecret` ✅
4. Type `telegram` → `botToken` field shown ✅
5. Type `custom` (no template) → generic blank key field shown ✅
6. Enter a secret value, then change provider → values preserved (template not overwritten) ✅
7. `pnpm lint` passes with no errors ✅
