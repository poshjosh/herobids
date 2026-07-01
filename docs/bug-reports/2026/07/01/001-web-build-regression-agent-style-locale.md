# Bug Report: Web Build Regression After Agent Style and Locale Edits

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-01
- **Summary:** The web production build regressed because the create-agent style change introduced invalid arrow-function syntax and the English locale file still contained a duplicate `credential.provider_mismatch` key.

## Root Cause

Two local defects were introduced in the same edit set:

1. In `apps/web/src/features/agents/AgentsPage.tsx`, a `setIntent` callback was converted from a concise arrow return to a block body, but the surrounding `({ ... })` wrapper was left in place. Esbuild parsed the callback body as an object literal and failed at `const next`.
2. In `apps/web/src/app/i18n/locales/en.ts`, the earlier `credential.provider_mismatch` entry was left in place after adding the later `credentialProvider`-based string, producing a duplicate object key warning during Vite build.

## Fix

- Rewrote the `setIntent` callback in `AgentsPage.tsx` as a proper block-body arrow function.
- Removed the stale duplicate English locale entry.
- Aligned the Arabic and Hindi `credential.provider_mismatch` placeholder names with the API payload (`credentialProvider`) to keep locale interpolation consistent.

## Files Changed

- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/app/i18n/locales/en.ts`
- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`

## Verification

- `pnpm lint`
- `pnpm --filter @herobids/web build`
