# Bug Report: Double Comma in Arabic Locale Breaks Vite Build

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** A double trailing comma (`,,`) on line 302 of the Arabic locale file (`ar.ts`) causes `vite build` to fail with `Expected identifier but found ","`.
- **Root Cause:** Line 302 in `apps/web/src/app/i18n/locales/ar.ts` had two trailing commas:
  ```ts
  'connections.revokeConfirm': '...',,
  ```
  This is a syntax error in JavaScript/TypeScript — a double comma is not valid in an object literal. Vite's esbuild transformer correctly rejects it.

- **Fix:** Removed the duplicate comma on line 302:
  ```diff
  -  'connections.revokeConfirm': 'هل تريد إلغاء هذا الاتصال؟ سيفقد الوكلاء والبوتات المستخدمون له الوصول.',,
  +  'connections.revokeConfirm': 'هل تريد إلغاء هذا الاتصال؟ سيفقد الوكلاء والبوتات المستخدمون له الوصول.',
  ```

- **Files Changed:**
  - `apps/web/src/app/i18n/locales/ar.ts` — removed duplicate comma on line 302

- **Verification:** `pnpm --filter @herobids/web run build` passes successfully (493 modules transformed, built in 2.19s).
