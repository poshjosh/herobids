# 015 — Hyperliquid credential template uses wrong field names

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-09
- **UAT reference:** C-02, C-03

---

## Summary

When a user types "hyperliquid" in the Add Credentials form, the secret field is pre-populated with
`privateKey`. However, the API (`validateVenueSecrets`) requires `apiKey`, `secret`, and
`walletAddress` for Hyperliquid credentials. Submitting the form produces a 400 error:

```
apiKey is required for Hyperliquid credentials;
secret is required for Hyperliquid credentials;
walletAddress is required for Hyperliquid credentials
```

## Root Cause

`apps/web/src/features/credentials/CredentialsPage.tsx` exports:
```typescript
export const PROVIDER_TEMPLATES: Record<string, string[]> = {
  hyperliquid: ['privateKey'],   // <-- wrong
  ...
};
```

`privateKey` is not a recognised alias for any Hyperliquid field in
`apps/api/src/routes/credentials.ts`. Hyperliquid uses `apiKey`, `secret`, and `walletAddress`.

This was an oversight in bug 007 (credentials-form-no-provider-templates.md), which added templates
but mapped Hyperliquid incorrectly.

## Fix

Update `PROVIDER_TEMPLATES` for `hyperliquid` to `['apiKey', 'secret', 'walletAddress']`
and update the corresponding unit test.

## Files Changed

- `apps/web/src/features/credentials/CredentialsPage.tsx`
- `apps/web/src/features/credentials/credentials-templates.test.ts`

## Verification

- Navigate to `/credentials` → Add provider credential → type "hyperliquid"
- Secret fields should show `apiKey`, `secret`, `walletAddress`
- Fill all three + label → Save → credential appears in list (or encryption error if key not configured)

