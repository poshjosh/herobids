# Advanced Settings Tabs — Create/Edit Agent Form Simplification

**Date:** 2026-06-24
**Status:** Implemented

## Problem

The Create Agent form's Advanced section had up to 4 levels of nesting
(accordion → accordion → accordion → collapsible sub-sections). Skill-related
inputs were also scattered across 3 separate places in the form. The UX was
subpar and intimidating for non-technical users, conflicting with the product
vision of bringing AI-first trading to laymen.

## Decisions

These decisions were settled with the user before implementation:

1. **Advanced layout** — Use **tabs** (Option A): a single collapsible
   "Advanced Settings" disclosure containing a flat tab strip
   (`AI Configuration · Skills · Trading Setup · Strategy`). At most one level
   of disclosure; no nested accordions.
2. **Skills in main form** — Keep only the **Skill Preset** dropdown in the main
   form. Do **not** render the read-only "selected skills" list — it is
   meaningless noise.
3. **Custom skill picker** — The editable `SkillPicker` lives in the Advanced →
   Skills tab (only rendered when preset is `custom`).
4. **Scope** — Apply to **both** Create (`AgentsPage`) and Edit
   (`EditAgentModal`) forms.

## Implementation Checklist

- [x] **Remove read-only skills display from the Create main form**
      (`AgentsPage.tsx`). Renumber field comments. `formatSkillSelection`
      remains used in the review screen.
- [x] **Convert `AdvancedSettingsSection` to tabs.** Single `<details>` wrapper
      ("Advanced Settings") containing a `role="tablist"` strip and one
      `role="tabpanel"`. Only the active tab's slot renders. Tabs whose slot is
      `null`/`false` are hidden; active index falls back to the first visible
      tab. Reuses existing i18n keys (`agents.create.advancedSettings`,
      `agents.advanced.{aiConfig,skills,tradingSetup,strategy}`).
- [x] **Flatten `TechnicalConfigSection` sub-collapsibles.** Remove the three
      internal toggles (Scan settings, Indicators, Confidence) and the
      `sectionHeader` helper + `useState`. Render each as a flat section with a
      lightweight heading.
- [x] **Apply tab layout to `EditAgentModal`.** Move Model overrides + Agent
      Controls into the AI tab, Trading guardrails into the Trading tab,
      Technical config into the Strategy tab. Keep core fields (capability,
      name, objective, skill picker, execution mode, capital, telegram) in the
      main body. Remove the duplicate read-only "selected skills" list and its
      now-unused `formatSkillSelection` import.
- [x] **Update affected tests.** `EditAgentModal.render.test.tsx`: three
      assertions changed because non-active tab panels are not in static markup
      — now assert the reachable tab labels
      (`agents.advanced.tradingSetup`, `agents.advanced.strategy`).
- [x] **Run tests and lint.** All 261 web tests pass. Verified no *new*
      TypeScript errors (pre-existing `@herobids/domain` resolution and
      `costPreset` payload errors confirmed by stashing).

## Files Touched

- `apps/web/src/features/agents/AdvancedSettingsSection.tsx`
- `apps/web/src/features/agents/AgentsPage.tsx`
- `apps/web/src/features/agents/TechnicalConfigSection.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/EditAgentModal.render.test.tsx`

## Out of Scope / Follow-ups

- **i18n translations** — no new message keys were introduced (all reused
  existing keys), so no catalog additions were required. If new tab copy is
  desired later, add keys to all locale catalogs.
- Other SCRATCHPAD UX items (validation-on-Review, capital→dailyLossLimit
  auto-fill, tick-interval minutes UX, strategy preset expansion) are tracked
  separately and were not part of this change.

## Notes / Consequences

- With tabs, only the active tab's content is in the DOM. Any future test or
  feature that relies on inspecting non-active tab content must first activate
  the tab (or assert on tab labels).
- The Skills tab is omitted entirely when the preset is not `custom`
  (slot is `null`), so the tab strip shrinks accordingly.
