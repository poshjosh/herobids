# Dynamic Advanced Field Tab Detection — Statement of Problem

## Context

The Create Agent form has an "Advanced Settings" accordion containing four tabs:
- **0** — AI Configuration (`tickIntervalMins`, `dailySpendBudgetUsd`, platform link, model selection)
- **1** — Skills
- **2** — Trading Setup (`maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `dailyLossLimit`, `maxSlippageBps`, `stopLossCooldownSecs`)
- **3** — Strategy (`venue`, technical config)

When the user submits the form (Review button) or blurs an invalid field, the accordion must:
1. Expand (if collapsed)
2. Switch to the tab that contains the offending field

## Problem

Today, the system knows which tab a field belongs to via a hand-maintained module-level map (`ADVANCED_FIELD_TAB` in `AgentsPage.tsx`). This map must be updated manually whenever:
- A validated field is added or removed from `form-validation.ts`
- A field moves from one tab to another
- A new tab is introduced

There is no compile-time or runtime enforcement that the map is accurate. A field can silently be missing from the map (no expand, wrong tab) or present with the wrong tab index (wrong tab surfaced). Both failures degrade UX without any visible error.

## Objective

Determine which Advanced Settings tab an error field belongs to **without a hand-maintained list** — i.e. the mapping should be derived from the form structure itself, so it cannot drift.

## Candidate Approaches

### A — Structural call-site encoding (blur only)
Pass the tab index at the JSX call site:
```tsx
// AI tab slot:
onBlurField={(field) => validateFieldOnBlur(field, 0)}
// Trading tab slot:
onBlurField={(field) => validateFieldOnBlur(field, 2)}
```
The mapping is implicit in the JSX structure. Moving a component to a different tab means updating the inline constant at the same location — no separate registry.

**Covers:** `onBlur`-triggered errors only. The Review handler still needs to know tab indices for errors it surfaces.

### B — Co-locate with the validator
Export a `FORM_FIELD_ADVANCED_TAB` map from `form-validation.ts` alongside the validator. Since every validated field is already enumerated in that file, the map is in the same place as the field definitions.

**Caveat:** Still hand-maintained — just in a better location. Adding a new validated field requires two edits in the same file (the validation rule + the map entry), which is better but not automatic.

### C — DOM-derived (fully automatic)
Render all tab panels (hidden via CSS, not unmounted). Add `data-tab-idx` to each panel container. After validation, query:
```ts
const el = detailsRef.current?.querySelector(`[data-field="${key}"]`);
const tabIdx = el?.closest('[data-tab-idx]')?.getAttribute('data-tab-idx');
```
The DOM structure *is* the mapping. Zero maintenance — moving a component to a different tab panel automatically updates the routing.

**Caveat:** Requires always rendering all tab content (minor memory/render cost). Tab panels that are currently unmounted (e.g. `skills` when `skillPreset !== 'custom'`) return `null`, so fields inside conditional renders would not be found. Those panels must at minimum render a hidden placeholder with the `data-tab-idx` attribute.

## Recommendation

**A for blur events** (zero coupling, co-located with the JSX structure that defines the relationship) combined with **C for Review errors** (fully automatic, removes the last hand-maintained list) — conditional renders permitting. If conditional renders make C impractical, fall back to B for the Review handler, accepting the two-edit discipline in exchange for simplicity.
