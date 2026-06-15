# Bug 2026-06-15-002: E2E Journeys 7, 8, 14 — `createAgent` helper can't locate skill checkboxes

## Date
2026-06-15

## Severity
LOW — E2E test/UI mismatch; no product regression.

## Summary
Journeys 7, 8, and 14 call `createAgent(page, goal, { skillIds: ['bot-management'] })`, which causes `helpers.ts` to call `page.getByRole('checkbox', { name: 'Bot Management' }).check()`. This times out because the Create Agent form only renders individual skill checkboxes when the skill preset is set to `'custom'`. In all other preset modes the selected skills are displayed as read-only text, not as checkable inputs.

## Root Cause
`CreateAgentFlow` defaults to `skillPreset: 'trading'`. When `skillPreset !== 'custom'`, the component renders a static string (e.g. "Includes: Bot Management, Trading") instead of a `<SkillPicker>` with checkboxes.

The `helpers.ts` `createAgent` function, when given `skillIds`, skips any preset switching and directly tries to `check()` a checkbox named after the skill — but those checkboxes don't exist until the form is switched to `'custom'` mode.

## Steps to Reproduce
Run any of:
- `pnpm exec playwright test journeys/07-mission-control-renders.spec.ts`
- `pnpm exec playwright test journeys/08-mission-control-capability-reflects.spec.ts`
- `pnpm exec playwright test journeys/14-create-agent-setup-escape-hatch.spec.ts`

## Expected
The "Bot Management" skill checkbox is visible and checkable.

## Actual
Timeout — element `getByRole('checkbox', { name: 'Bot Management' })` never appears.

## Fix Required
Update `tests/e2e/helpers.ts` `createAgent`: when `skillIds` is non-empty, first switch the skill preset dropdown to `'custom'` so `<SkillPicker>` renders with individual checkboxes, then check each skill by name.

```ts
// In createAgent, before the skillIds loop:
if ((options.skillIds ?? []).length > 0) {
  // Switch to custom preset to expose individual skill checkboxes
  await page.getByRole('combobox', { name: /skill preset/i }).selectOption('custom');
  // ... then check individual skills
}
```

## Files
- `tests/e2e/helpers.ts`
- `tests/e2e/journeys/07-mission-control-renders.spec.ts`
- `tests/e2e/journeys/08-mission-control-capability-reflects.spec.ts`
- `tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`
- `apps/web/src/features/agents/AgentsPage.tsx`
