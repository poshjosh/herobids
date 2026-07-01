# Bug Report: Skills Page Runtime Crash — `intl` Undefined in `SkillCard`

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-01
- **Summary:** Opening the Skills page could crash the app because `SkillCard` called `intl.formatMessage(...)` without defining `intl` in that component scope.

## Root Cause

A recent copy change replaced hardcoded publish button text in `SkillCard` with `intl.formatMessage(...)`, but unlike the parent `SkillsPage` component, `SkillCard` did not create its own `const intl = useIntl()` binding. That produced a browser-side `ReferenceError` at render time.

## Fix

Added `const intl = useIntl();` inside `SkillCard` so the localized publish labels resolve within the component’s own render scope.

## Files Changed

- `apps/web/src/features/skills/SkillsPage.tsx`

## Verification

- `pnpm lint`
- `pnpm --filter @herobids/web build`
