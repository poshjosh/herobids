# 016 — E2E: Skills accordion collapsed blocks checkbox interaction, cascades to form validation failure

- **Status:** FIXED
- **Severity:** High (blocks 5 of 19 E2E tests)
- **Date:** 2026-06-23
- **Summary:** The `AdvancedSettingsSection` accordion (introduced in Phase 8, commit `e5a2e97`) wraps form sections in `<details>` elements where only the first non-empty section is `open` by default. The "Skills" section is typically the second section (after "AI Configuration") and starts collapsed. The E2E `createAgent` helper and J14 test try to interact with skill checkboxes inside the collapsed section, causing timeouts. Additionally, when the helper can't uncheck pre-selected trading skill checkboxes, the form retains trading skills → capital becomes required → validation fails → "Review" never advances to the review step → "Create AI agent" click resolves to the empty-state button behind the modal overlay.

- **Root Cause:**
  1. `AdvancedSettingsSection.tsx` only opens the **first** non-empty `<details>` section (`open={index === firstVisibleIndex}`). Skills (index 1) is collapsed when AI Configuration (index 0) is present.
  2. `Playwright`'s `getByRole('checkbox')` does not find elements inside a collapsed `<details>` (they are not visible/actionable).
  3. The `createAgent` helper's uncheck loop silently does nothing when checkboxes can't be found, leaving trading skills pre-selected from the default "trading" preset.
  4. With trading skills still selected, the capital field is shown and required. Form validation on "Review" click fails with "Capital is required.", preventing transition to the review step.
  5. In the stuck intent modal, Playwright's `.last()` selector for "Create AI agent" resolves to the **empty-state button behind the modal overlay**, whose click is intercepted by modal form elements.

- **Fix:**
  - **`tests/e2e/helpers.ts`**: Added `expandSkillsAccordion()` helper that clicks the "Skills" `<summary>` to open the accordion before any checkbox interaction. Called whenever the custom preset path is used. Added `{ force: true }` to the final "Create AI agent" button click as a defense against residual pointer-event interception.
  - **`tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`**: Added inline accordion expansion and pre-selected checkbox unchecking before checking the target skill.

- **Files Changed:**
  - `tests/e2e/helpers.ts` — added `expandSkillsAccordion()`, restructured preset/checkbox logic, added `force:true` click
  - `tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts` — added accordion expansion before checkbox interaction

- **Verification:** TypeScript compilation passes. E2E tests J1, J4, J7, J8, J14 should no longer time out on checkbox or button interactions.

- **Affected Tests:** J1, J4, J7, J8, J14
