# Bug Report: LoginPage Form Labels Missing `htmlFor`/`id` Associations

**Date**: 2026-06-06
**Severity**: High (broke `getByLabel()` Playwright locators for all form fields)
**Component**: `apps/web/src/features/auth/LoginPage.tsx`

## Summary

The Name, Email, and Password `<label>` elements in `LoginPage.tsx` had no `htmlFor` attribute, and the corresponding `<input>` elements had no matching `id`. Playwright's `getByLabel(/name/i)`, `getByLabel(/email/i)`, and `getByLabel(/password/i)` locators rely on the programmatic label association (`htmlFor` → `id`) to find the correct input. Without this, the locators fail because ARIA label resolution requires either:

1. `<label htmlFor="id">` + `<input id="id">`, or
2. The input nested *inside* the label element

## Root Cause

```tsx
// Before (broken — sibling layout, no htmlFor/id)
<label style={...}>Email</label>
<input type="email" ... />
```

Playwright uses the ARIA accessible name computation, which does not associate a label with a sibling input unless `htmlFor`/`id` is present.

## Fix

Added `htmlFor`/`id` pairs to all three form fields:

```tsx
// After (fixed)
<label htmlFor="login-name" style={...}>Name</label>
<input id="login-name" type="text" ... />

<label htmlFor="login-email" style={...}>Email</label>
<input id="login-email" type="email" ... />

<label htmlFor="login-password" style={...}>Password</label>
<input id="login-password" type="password" ... />
```

## Impact

`getByLabel(/name/i)`, `getByLabel(/email/i)`, `getByLabel(/password/i)` in all E2E journeys would have timed out once the tab click succeeded.

## Files Changed

- `apps/web/src/features/auth/LoginPage.tsx`
