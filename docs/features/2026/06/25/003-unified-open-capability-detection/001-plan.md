# Unify Trading Capability Detection

Status: pending
Created: 2026-06-25
Scope: Replace hardcoded skill-ID checks in `deriveCapabilityMode` with metadata-based `hasCapabilityFamily`, and consolidate all trading-detection paths to one helper.

## Problem

Three independent mechanisms determine whether an agent "has trading capability" in the create/edit forms. They can diverge:

| Location | Mechanism | Works for custom skills? |
|---|---|---|
| `requiresTradingSetup` (AgentsPage L345) | `skillPreset === 'trading' \|\| hasCapabilityFamily(selectedSkills, 'trading')` | Yes |
| `deriveCapabilityMode` (derive-capability-mode.ts L4) | `skillIds.includes('trading') \|\| skillIds.includes('bot-management')` | **No** |
| `hasBotManagementSkill` (AgentsPage L329) | `intent.skillIds.includes('bot-management')` | N/A (bot-specific, not a trading check) |

A custom skill with `capabilityFamilies: ['trading']` and a non-standard ID (e.g. `my-strategy`) causes the Trading Setup tab to show (`requiresTradingSetup` = true) but the Strategy tab to hide (`deriveCapabilityMode` returns `'intelligence'` instead of `'both'`).

## Design Decisions

**D1: Change `deriveCapabilityMode` to accept skill objects instead of skill IDs.**

The function currently receives `skillIds: string[]` and hardcodes which IDs count as trading. Changing the signature to accept `Array<{ capabilityFamilies: string[] }>` lets it call `hasCapabilityFamily` and correctly detect any skill tagged with the `'trading'` family — including future custom skills.

**D2: Keep the `skillPreset === 'trading'` synchronous shortcut on `requiresTradingSetup`.**

This shortcut provides instant feedback when the user picks the trading preset, before the skills metadata query resolves. Removing it would cause the Trading Setup tab to flicker during loading. The shortcut is safe because the `'trading'` preset hardcodes `['bot-management', 'trading']` — both of which have `capabilityFamilies: ['trading']` — so the shortcut and the metadata check always agree for built-in presets.

**D3: Apply the same `skillPreset` shortcut to the `deriveCapabilityMode` useEffect to prevent a parallel flicker on the Strategy tab.**

The `deriveCapabilityMode` useEffect currently uses `intent.skillIds` synchronously. After D1, it would depend on resolved skill objects from the async query. Without a shortcut, switching to the trading preset would briefly derive `'intelligence'` (no skills loaded yet) then flip to `'both'` — causing the Strategy section to appear/disappear. Adding `state.skillPreset === 'trading'` as a synchronous fallback eliminates this.

**D4: Do not change `EditAgentModal`'s fallback to `currentHasTradingCapability`.**

The edit modal's approach — use `hasCapabilityFamily` when skills are loaded, fall back to the persisted capability-readiness API response when not — is correct for editing existing agents. It handles a scenario the create form doesn't face (agent already exists with trading capability but skill metadata not yet fetched). Leave it as-is.

**D5: Do not change `hasBotManagementSkill`.**

This check gates bot-specific UI controls (bot controls in the AI Config tab), not generic trading detection. It intentionally checks for the specific `'bot-management'` skill ID, which is correct.

## Implementation

### Step 1 — Refactor `deriveCapabilityMode` signature and body

File: `apps/web/src/features/agents/derive-capability-mode.ts`

Change:
```typescript
import type { CapabilityMode } from './CapabilitySelector.js';

export function deriveCapabilityMode(skillIds: string[], goal: string): CapabilityMode {
  const hasTradingSkill = skillIds.includes('trading') || skillIds.includes('bot-management');
  const hasIntelligence = goal.trim().length > 0;
  if (hasTradingSkill && hasIntelligence) return 'both';
  if (hasIntelligence) return 'intelligence';
  return 'technical';
}
```

To:
```typescript
import type { CapabilityMode } from './CapabilitySelector.js';
import { hasCapabilityFamily } from './agent-display.js';

export function deriveCapabilityMode(
  skills: Array<{ capabilityFamilies: string[] }>,
  goal: string,
): CapabilityMode {
  const hasTradingSkill = hasCapabilityFamily(skills, 'trading');
  const hasIntelligence = goal.trim().length > 0;
  if (hasTradingSkill && hasIntelligence) return 'both';
  if (hasIntelligence) return 'intelligence';
  return 'technical';
}
```

### Step 2 — Update `AgentsPage.tsx` useEffect caller

File: `apps/web/src/features/agents/AgentsPage.tsx` (~L297–306)

The `useEffect` that calls `deriveCapabilityMode` must now pass resolved skill objects instead of skill IDs. Add `skills` (from the skills query) to the dependency array and use `resolveSelectedSkills` inside the effect. Include the `skillPreset === 'trading'` shortcut (D3) to prevent flicker.

Change:
```typescript
  useEffect(() => {
    setIntent((state) => {
      const derived = deriveCapabilityMode(state.skillIds, state.goal);
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [intent.skillIds, intent.goal]);
```

To:
```typescript
  useEffect(() => {
    setIntent((state) => {
      const resolvedSkills = skills.filter((s) => state.skillIds.includes(s.id));
      // Synchronous shortcut: the 'trading' preset always maps to skills with
      // capabilityFamilies: ['trading'], so treat it as trading even before the
      // skills query resolves — prevents a flicker on the Strategy tab.
      const syntheticTradingSkill = state.skillPreset === 'trading'
        ? [{ capabilityFamilies: ['trading'] }]
        : [];
      const effectiveSkills = resolvedSkills.length > 0 ? resolvedSkills : syntheticTradingSkill;
      const derived = deriveCapabilityMode(effectiveSkills, state.goal);
      if (derived !== state.capabilityMode) {
        return { ...state, capabilityMode: derived };
      }
      return state;
    });
  }, [intent.skillIds, intent.goal, skills]);
```

Note: `skills` is already in scope — it is computed from `skillsQuery.data` earlier in the component.

### Step 3 — Update `EditAgentModal.tsx` if it calls `deriveCapabilityMode`

`EditAgentModal` does **not** call `deriveCapabilityMode` — it receives `capabilityMode` from the persisted agent data and computes `hasTradingCapability` independently. No change needed.

### Step 4 — Update tests

File: `apps/web/src/features/agents/derive-capability-mode.test.ts`

Update all test cases to pass skill objects instead of skill ID strings.

Change from:
```typescript
expect(deriveCapabilityMode(['trading'], 'Trade BTC')).toBe('both');
```

To:
```typescript
expect(deriveCapabilityMode([{ capabilityFamilies: ['trading'] }], 'Trade BTC')).toBe('both');
```

Add a new test for the custom-skill edge case:
```typescript
it('returns both when custom skill has trading capability family and goal', () => {
  expect(deriveCapabilityMode([{ capabilityFamilies: ['trading'] }], 'My custom strategy')).toBe('both');
});

it('returns intelligence when custom skill has no trading capability family', () => {
  expect(deriveCapabilityMode([{ capabilityFamilies: ['analytics'] }], 'Analyse data')).toBe('intelligence');
});
```

### Step 5 — Verify no other callers

`deriveCapabilityMode` is imported in exactly two places:
1. `AgentsPage.tsx` (updated in Step 2)
2. `derive-capability-mode.test.ts` (updated in Step 4)

No other files import or call it.

## Files Changed

| File | Change |
|---|---|
| `apps/web/src/features/agents/derive-capability-mode.ts` | New signature, import `hasCapabilityFamily`, use metadata check |
| `apps/web/src/features/agents/AgentsPage.tsx` | Resolve skills in useEffect, add `skills` to dep array, add preset shortcut |
| `apps/web/src/features/agents/derive-capability-mode.test.ts` | Update all test inputs to skill objects, add custom-skill tests |

## Edge Cases

1. **Skills query not yet loaded + trading preset selected**: The `skillPreset === 'trading'` shortcut in Step 2 ensures `deriveCapabilityMode` receives a synthetic `{ capabilityFamilies: ['trading'] }` entry, so `capabilityMode` is immediately `'both'`. No flicker.

2. **Skills query not yet loaded + custom preset with trading skill**: `resolvedSkills` is `[]` and `syntheticTradingSkill` is `[]` (preset is `'custom'`). `deriveCapabilityMode` returns `'intelligence'` (if goal) or `'technical'` (if not). When the query resolves, the effect re-runs and corrects to `'both'`. Brief transient state — acceptable because custom-preset users are in the skill picker, which itself needs the skills query to render options. By the time they've selected a skill, the query has resolved.

3. **`bot-management` skill without a goal**: `deriveCapabilityMode` returns `'technical'` (same as today). `requiresTradingSetup` is true. Trading Setup tab shows, Strategy tab does not. This is correct — without a goal, there is no intelligence component.

## What This Does NOT Fix

- **`EditAgentModal`'s `showTradingControls` fallback logic** (showing controls if any trading field has a value). This is intentionally different from the create flow — it prevents hiding fields that have data. No change warranted.
- **`hasBotManagementSkill` hardcoded ID check**. This is skill-specific, not capability-family detection. Correct as-is.

## Effort

~30 minutes. Three files, no new dependencies, no schema or API changes.
