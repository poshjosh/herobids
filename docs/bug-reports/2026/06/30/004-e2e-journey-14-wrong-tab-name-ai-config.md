# Bug Report: E2E Journey 14 — Wrong Tab Name "AI Config" Should Be "AI"

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-30
- **Summary:** E2E test Journey 14 (`14-create-agent-setup-escape-hatch.spec.ts`) fails because it looks for a tab named `"AI Config"` but the actual i18n tab label is `"AI"` (from key `agents.advanced.aiConfig`). The tab lookup silently returns zero matches, so the tab is never switched and the connection setup content (in the AI tab) is never made visible.
- **Root Cause:**
  1. `tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts` line 78: `page.getByRole('tab', { name: 'AI Config' })` references a tab label that does not exist.
  2. `apps/web/src/app/i18n/locales/en.ts` line 341: The actual tab label is `'AI'` (not `'AI Config'`), mapped from key `agents.advanced.aiConfig`.
  3. The `getByRole` call returns zero elements, so the `if (await aiConfigTab.count() > 0)` guard silently skips the tab switch, leaving the Skills tab active. The connection setup UI (`"No active platform links yet"` / `"Set up trading now"`) lives in the AI tab and is never revealed.
- **Fix:**
  - **`tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`**: Changed `page.getByRole('tab', { name: 'AI Config' })` to `page.getByRole('tab', { name: 'AI' })` and updated the associated comment.
- **Files Changed:**
  - `tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`
- **Verification:**
  - `pnpm lint` (tsc --noEmit) passes (test file is not type-checked by tsc).
  - The fix aligns the tab name reference with the actual i18n label.
  - E2E Journey 14 should now correctly switch to the AI tab and find the `"No active platform links yet"` text.
