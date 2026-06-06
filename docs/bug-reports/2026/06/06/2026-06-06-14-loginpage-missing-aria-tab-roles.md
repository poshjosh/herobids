# Bug Report: LoginPage Tab Buttons Missing ARIA `role="tab"` Broke All E2E Tests

**Date**: 2026-06-06
**Severity**: Critical (blocked all 6 Playwright E2E journeys)
**Component**: `apps/web/src/features/auth/LoginPage.tsx`

## Summary

The Google/Email tab switcher in `LoginPage.tsx` used plain `<button>` elements without `role="tab"` or a `role="tablist"` container. Playwright's `getByRole('tab', { name: /email/i })` locator (used in every E2E helper that performs login/register) timed out because no element with `role="tab"` existed in the DOM.

## Root Cause

```tsx
// Before (broken)
<div style={{ ... }}>
  {(['google', 'email'] as const).map((t) => (
    <button key={t} onClick={...}>
      {t === 'google' ? 'Google' : 'Email'}
    </button>
  ))}
</div>
```

The tab container lacked `role="tablist"` and each button lacked `role="tab"` and `aria-selected`.

## Fix

Added proper ARIA attributes:

```tsx
// After (fixed)
<div role="tablist" style={{ ... }}>
  {(['google', 'email'] as const).map((t) => (
    <button
      key={t}
      role="tab"
      aria-selected={tab === t}
      onClick={...}
    >
      {t === 'google' ? 'Google' : 'Email'}
    </button>
  ))}
</div>
```

## Impact

All 6 E2E journeys failed at the first step (`registerUser()` / `loginUser()` helpers) with a 30–60 second timeout waiting for `getByRole('tab', { name: /email/i })`.

## Files Changed

- `apps/web/src/features/auth/LoginPage.tsx`
