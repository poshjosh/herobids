# Bug Report — Settings Telegram Save Button Always Enabled

- **Status:** CLOSED
- **Tests:** `apps/web/src/features/settings/settings-save-guard.test.ts` — validates the `isSaveDisabled` predicate: disabled when input empty and no saved value; disabled when input matches saved value; enabled when value differs; enabled for first-time entry; enabled when clearing a saved value
- **Severity:** Medium
- **Date:** 2026-06-09
- **Summary:** The "Save" button on the Settings page Telegram Notifications form was always enabled (only disabled during an in-flight mutation). Clicking "Save" with an empty chat ID or with the same value as already saved would fire an API call and display a misleading "Telegram chat ID saved." success banner without any real change being made.

## Root Cause

The button's `disabled` prop only guarded against the pending state:

```tsx
// Before (bug)
<Button variant="primary" type="submit" disabled={telegramMutation.isPending}>
```

There was no guard to prevent the button being clickable when the current input value matched the already-saved value (or both were empty/null).

## Fix

Added a second condition to compare the current input with the saved server value:

```tsx
// After (fix)
<Button variant="primary" type="submit"
  disabled={telegramMutation.isPending || telegramChatId.trim() === (meQuery.data?.telegramChatId ?? '')}>
```

- When the user has no saved chat ID and the field is empty → button disabled (no-op save prevented)
- When the user hasn't changed the saved chat ID → button disabled (redundant call prevented)
- When the user has typed a new value → button enabled as expected

## Files Changed

- `apps/web/src/features/settings/SettingsPage.tsx` (line ~85)

## Verification

1. Navigate to `/settings`
2. With no Telegram chat ID set (meQuery returns `telegramChatId: null`): "Save" button is disabled ✅
3. Enter a chat ID, click Save → button enabled, mutation fires ✅
4. After save completes, query invalidates, `meQuery.data.telegramChatId` updates → button disables again (value matches saved) ✅
5. `pnpm lint` passes with no errors ✅
