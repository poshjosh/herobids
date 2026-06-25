# 004 — Unified Agent Form

## Problem

The create-agent form (`CreateAgentFlow` in `AgentsPage.tsx`) and edit-agent form (`EditAgentModal.tsx`) duplicate the same field layout, validation wiring, and sub-component assembly. The create form is the target design; the edit form is outdated and will keep drifting every time the create form changes.

## Goal

Extract a single shared **form body** component (`AgentFormBody`) that both the create flow and the edit modal consume. Field changes happen once, both screens get them.

## Approach

**Extract the body, keep two shells.**

- `AgentFormBody.tsx` — shared presentational component. Renders all form fields in the canonical order. Owns validation wiring. Has zero knowledge of create vs edit.
- `CreateAgentFlow` (in `AgentsPage.tsx`) — create shell. Owns intent/review steps, style orchestration, skill presets, trading-binding picker, auto-name, auto-telegram, auto-loss-limit, `create()` + `bind()`.
- `EditAgentModal.tsx` — edit shell. Owns modal chrome, `agentToFormState()` mapping, legacy tick-interval preservation, `update()`.

Differences between shells are injected as `ReactNode` slots — never as `mode` flags inside the body.

---

## Types

### `AgentFormState`

The unified state type for the shared form body. Both shells convert to/from it.

```ts
// agent-form-state.ts

import type { CapabilityMode } from './CapabilitySelector.js';
import type { TechnicalConfigFormState } from './technical-config-helpers.js';

export interface AgentFormState {
  // Identity
  name: string;
  goal: string;

  // Capability
  capabilityMode: CapabilityMode;
  technicalConfig: TechnicalConfigFormState;

  // Skills
  skillIds: string[];

  // Trading setup
  executionMode: 'paper' | 'shadow' | 'live' | '';
  capital: string;

  // Notifications
  telegramChatId: string;

  // AI cost controls
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;

  // Trading guardrails
  dailyLossLimit: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
}
```

Fields intentionally **absent** from `AgentFormState` (they stay in shell-local state):
- `style`, `riskTolerance`, `skillPreset` — create-only orchestration.
- `tradingBindingId`, `venue`, `venueType` — create-only trading-binding picker.
- `provider`, `lightModel`, `heavyModel` — model selection is injected as a `modelSlot`.
- `modelOverrideEnabled` — edit-only toggle.

### `AgentFormBodyProps`

```ts
// AgentFormBody.tsx

import type { Skill } from '../../lib/api-client.js';
import type { ValidationConstraints } from './form-validation.js';

export interface AgentFormBodyProps {
  // Core form state
  value: AgentFormState;
  onChange: (patch: Partial<AgentFormState>) => void;

  // Display flags (computed by caller)
  showIntelligence: boolean;
  showTechnical: boolean;
  showTradingControls: boolean;
  requiresTradingSetup: boolean;
  isAdmin: boolean;

  // Skills
  selectableSkills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;

  // Validation
  formErrors: Record<string, string>;
  onClearFieldError: (field: string) => void;
  onBlurField: (field: string) => void;
  validationConstraints: ValidationConstraints;

  // Tick interval
  tickIntervalError: string | null;
  tickIntervalNotice?: string | null;
  effectiveTickIntervalMs?: number | null;

  // Risk defaults (for TradingGuardrailsFields)
  riskDefaults: { maxOpenPositions?: number; maxPositionSizePct?: number; stopLossPct?: number; dailyLossLimitDefaultRatio?: number } | null;

  // Slots (caller injects shell-specific chrome)
  modelSlot: React.ReactNode;
  skillsSlot?: React.ReactNode;                // create: custom-preset SkillPicker; edit: always-visible SkillPicker
  tradingBindingSlot?: React.ReactNode;         // create: binding picker + setup; edit: null
  tradingSetupSlot?: React.ReactNode;           // create: executionMode + riskTolerance + guardrails; edit: executionMode + guardrails
  capabilityWarning?: React.ReactNode;          // edit: "switching to technical" banner; create: null
  nameAutoHint?: React.ReactNode;               // create: auto-generated name notice; edit: null
}
```

---

## Implementation checklist

### Phase 1: Create `AgentFormState` and `agentToFormState` helper

- [ ] **1.1** Create `agent-form-state.ts` with `AgentFormState` interface.

- [ ] **1.2** Create `agentToFormState(agent: Agent): AgentFormState` in the same file.
  - `goal` ← `extractAgentObjective(agent.prompt)`
  - `capabilityMode` ← derive from `agent.technical` and extracted objective, using the same logic as `EditAgentModal` currently does (`agent.technical ? (goal.trim() ? 'both' : 'technical') : 'intelligence'`)
  - `technicalConfig` ← `agent.technical ? technicalConfigToFormState(agent.technical) : defaultTechnicalConfigFormState()`
  - `skillIds` ← `agent.skillIds ?? []`
  - `executionMode` ← `agent.executionMode ?? ''`
  - `capital` ← `agent.capital ?? ''`
  - `telegramChatId` ← `agent.telegramChatId ?? ''`
  - `costPreset` ← `agent.costPreset ?? ''`
  - `dailySpendBudgetUsd` ← `agent.dailySpendBudgetUsd != null ? String(agent.dailySpendBudgetUsd) : ''`
  - `tickIntervalMins` ← `formatTickIntervalMinutesForInput(agent.tickIntervalMs)`
  - `dailyLossLimit` ← `agent.dailyLossLimit ?? ''`
  - `maxSlippageBps` ← `agent.maxSlippageBps != null ? String(agent.maxSlippageBps) : ''`
  - `maxOpenPositions` ← `agent.maxOpenPositions != null ? String(agent.maxOpenPositions) : ''`
  - `maxPositionSizePct` ← `agent.maxPositionSizePct ?? ''`
  - `stopLossPct` ← `agent.stopLossPct ?? ''`
  - `stopLossCooldownSecs` ← `agent.stopLossCooldownMs != null ? String(agent.stopLossCooldownMs / 1000) : ''`
  - `openPositionEscalationToJudgePolicy` ← `agent.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered'` (cast after validation)

- [ ] **1.3** Create `intentToFormState(intent: IntentState): AgentFormState` — trivial field-rename mapper. `IntentState` already contains all `AgentFormState` fields; this picks the subset.

### Phase 2: Create `AgentFormBody` component

- [ ] **2.1** Create `AgentFormBody.tsx` with the `AgentFormBodyProps` interface above.

- [ ] **2.2** Move the `ADVANCED_FIELD_TAB` constant into `AgentFormBody.tsx` — currently duplicated in both `AgentsPage.tsx` and `EditAgentModal.tsx`.

- [ ] **2.3** Move the validation-handler trio into `AgentFormBody` (as internal implementation):
  - `clearFieldError(field)` — delegates to `props.onClearFieldError`
  - `bumpAdvancedExpand(errorKeys)` — internal state
  - `validateFieldOnBlur(fieldName)` — calls `validateCreateAgentForm()` with current `props.value`

  The body owns its own `advancedExpandSeq` and `advancedErrorTabIdx` state (presentation concerns).

- [ ] **2.4** Render the canonical field order:
  ```
  capabilityWarning slot          (if provided)
  goal textarea                   (if showIntelligence)
  capital field                   (if showTradingControls && requiresTradingSetup)
  telegramChatId field
  name field + nameAutoHint slot
  AdvancedSettingsSection
    aiConfig tab:
      modelSlot
      tradingBindingSlot          (if provided)
      AgentControlsSection
    skills tab:
      skillsSlot                  (if provided, else:)
      SkillPicker                 (if showIntelligence)
    tradingSetup tab:
      tradingSetupSlot            (if provided)
    strategy tab:
      TechnicalConfigSection      (if showTechnical)
  ```

- [ ] **2.5** The body exposes no submit button, no modal chrome, no step logic. It is a pure controlled form body — the shell wraps it in a `<form>`, `<Modal>`, and buttons.

### Phase 3: Refactor `CreateAgentFlow` to use `AgentFormBody`

- [ ] **3.1** Import `AgentFormBody` and `AgentFormState`.

- [ ] **3.2** Keep `IntentState` in the create shell. It extends `AgentFormState` with create-only fields: `style`, `riskTolerance`, `skillPreset`, `tradingBindingId`, `venue`, `venueType`, `provider`, `lightModel`, `heavyModel`.

- [ ] **3.3** Replace the inline field JSX in the intent step with `<AgentFormBody>`:
  ```tsx
  <AgentFormBody
    value={intentToFormState(intent)}
    onChange={(patch) => setIntent(s => ({ ...s, ...patch }))}
    showIntelligence={showIntelligence}
    showTechnical={showTechnical}
    showTradingControls={requiresTradingSetup}
    requiresTradingSetup={requiresTradingSetup}
    isAdmin={meQuery.data?.isAdmin ?? false}
    selectableSkills={skills}
    skillsLoading={skillsLoading}
    skillsError={skillsError}
    formErrors={formErrors}
    onClearFieldError={clearFieldError}
    onBlurField={validateFieldOnBlur}
    validationConstraints={validationConstraints}
    tickIntervalError={tickIntervalError}
    riskDefaults={riskDefaultsQuery.data ?? null}
    modelSlot={<ModelSelectionFields ... />}
    skillsSlot={intent.skillPreset === 'custom' ? <SkillPicker ... /> : null}
    tradingBindingSlot={<TradingBindingPicker ... />}
    tradingSetupSlot={<TradingSetupSection ... />}
    nameAutoHint={nameIsAutoGenerated ? <span>...</span> : null}
  />
  ```

- [ ] **3.4** Keep create-only elements outside `AgentFormBody`:
  - `StyleSelector` — above the form body
  - Skill preset dropdown — above the form body
  - Review step — stays in the shell's step 2 render
  - `ProviderSetupForm` — stays in the shell's conditional render

- [ ] **3.5** Remove the duplicated `ADVANCED_FIELD_TAB`, `clearFieldError`, `bumpAdvancedExpand`, `validateFieldOnBlur` from `CreateAgentFlow` — they now live in `AgentFormBody`.

- [ ] **3.6** Remove deleted inline field JSX (goal, name, capital, telegram, advanced-settings assembly).

### Phase 4: Refactor `EditAgentModal` to use `AgentFormBody`

- [ ] **4.1** Import `AgentFormBody`, `AgentFormState`, and `agentToFormState`.

- [ ] **4.2** Replace `FormState` with `AgentFormState`. Initialize with `agentToFormState(initialData)`.

- [ ] **4.3** Replace inline field JSX with `<AgentFormBody>`:
  ```tsx
  <AgentFormBody
    value={form}
    onChange={(patch) => {
      if (patch.tickIntervalMins !== undefined) setTickIntervalTouched(true);
      setForm(s => ({ ...s, ...patch }));
    }}
    showIntelligence={showIntelligence}
    showTechnical={showTechnical}
    showTradingControls={showTradingControls}
    requiresTradingSetup={false}
    isAdmin={isAdmin ?? false}
    selectableSkills={selectableSkills}
    skillsLoading={skillsQuery.isLoading}
    skillsError={skillsQuery.error instanceof Error ? skillsQuery.error.message : null}
    formErrors={formErrors}
    onClearFieldError={clearFieldError}
    onBlurField={validateFieldOnBlur}
    validationConstraints={validationConstraints}
    tickIntervalError={tickIntervalError}
    tickIntervalNotice={tickIntervalNotice}
    effectiveTickIntervalMs={effectiveTickIntervalMs}
    riskDefaults={riskDefaultsQuery.data ?? null}
    modelSlot={<ModelInheritOverrideBox ... />}
    skillsSlot={showIntelligence ? <SkillPicker ... /> : null}
    tradingSetupSlot={showTradingControls ? <TradingGuardrailsSection ... /> : null}
    capabilityWarning={capabilityWarning}
  />
  ```

- [ ] **4.4** Keep edit-only concerns in the shell:
  - `CapabilitySelector` — above the form body (or drop it, per earlier discussion — but that's a separate decision; this plan preserves current edit behaviour while unifying the body)
  - Model inherit/override toggle — passed as `modelSlot`
  - `preservedSkillIds` — handled in the shell's submit logic, not in the body
  - Legacy tick interval state (`tickIntervalTouched`, `effectiveTickIntervalMs`) — shell state, passed as props

- [ ] **4.5** Remove the duplicated `ADVANCED_FIELD_TAB`, `clearFieldError`, `bumpAdvancedExpand`, `validateFieldOnBlur`, and inline field JSX.

- [ ] **4.6** Update `buildUpdateAgentPayload` call to map from `AgentFormState` field names (notably `goal` → `prompt` in the update payload input, or rename `UpdateAgentPayloadInput.prompt` → `goal` for consistency).

### Phase 5: Update tests

- [ ] **5.1** Update `EditAgentModal.render.test.tsx` — the component now renders `AgentFormBody` internally. Tests should still pass since fields are the same; fix any selector changes.

- [ ] **5.2** If desired, add a unit test for `AgentFormBody` in isolation — render with props, verify fields appear for different `show*` flag combinations. This is optional but recommended since it replaces testing in two places.

- [ ] **5.3** Verify `AgentControlsSection.test.tsx` is unaffected (it tests a leaf component, not the form body).

### Phase 6: Update user-acceptance tests

- [ ] **6.1** In `docs/tech/user-acceptance-tests.md`, add a new **Edit agent form** subsection under the Agents (`/agents`) section (after the existing AG-S* rows).

  Add the following UAT cases (use next available AG-E* IDs):

  | ID | Title | Steps | Expected |
  |---|---|---|---|
  | AG-E01 | Edit form opens | On agent detail, click "Edit config" | Edit modal opens; all fields pre-filled from agent data (name, goal, style, capital, etc.) |
  | AG-E02 | Style selector pre-filled | Open edit form for an agent with a known style | Style selector reflects the agent's current style (or "Balanced" if unknown) |
  | AG-E03 | Style change drives defaults | In edit form, change Style from Careful to Bold | Cost preset, tick interval, and daily budget update to Bold defaults |
  | AG-E04 | Save changes — happy path | Edit name and goal; click "Save changes" | Modal closes; agent detail reflects updated name and goal |
  | AG-E05 | Save changes — validation | Clear name field; click "Save changes" | Error shown; form not dismissed |
  | AG-E06 | Shadow mode admin-only in edit | As non-admin: open edit form for a trading agent | Execution mode dropdown shows only "Paper" and "Live". As admin: "Shadow" also available. |
  | AG-E07 | Advanced settings tabs present | Open edit form; expand Advanced Settings | Four tabs visible: AI Configuration, Skills, Trading Setup, Strategy — same as create form |
  | AG-E08 | Skills editable in Advanced | Open edit form; expand Advanced Settings → Skills tab | SkillPicker shown; skill changes reflected on save |
  | AG-E09 | Model selection visible | Open edit form for agent with intelligence capability | AI Configuration tab shows model provider/economy/premium fields directly (no inherit/override toggle) |
  | AG-E10 | Guardrails editable | Open edit form; expand Advanced Settings → Trading Setup | Daily loss limit, max slippage, max open positions, stop-loss fields present and editable |

### Phase 7: Cleanup

- [ ] **7.1** Run `pnpm lint` — must pass.

- [ ] **7.2** Run `pnpm test` — must pass.

- [ ] **7.3** Verify no dead imports remain in `AgentsPage.tsx` or `EditAgentModal.tsx`.

---

## Files touched

| File | Action |
|---|---|
| `agent-form-state.ts` | **NEW** — `AgentFormState`, `agentToFormState()`, `intentToFormState()` |
| `AgentFormBody.tsx` | **NEW** — shared form body component |
| `AgentsPage.tsx` | **EDIT** — `CreateAgentFlow` refactored to use `AgentFormBody`; inline fields, `ADVANCED_FIELD_TAB`, handler trio removed |
| `EditAgentModal.tsx` | **EDIT** — refactored to use `AgentFormBody`; `FormState` replaced with `AgentFormState`; inline fields, `ADVANCED_FIELD_TAB`, handler trio removed |
| `agent-payloads.ts` | **EDIT** (minor) — rename `UpdateAgentPayloadInput.prompt` → `goal` for consistency, or add a mapping in the edit shell |
| `EditAgentModal.render.test.tsx` | **EDIT** — fix selectors if DOM structure changed |

## Files NOT touched

| File | Why |
|---|---|
| `AdvancedSettingsSection.tsx` | Leaf component, consumed as-is |
| `AgentControlsSection.tsx` | Leaf component, consumed as-is |
| `TradingGuardrailsFields` (in `AgentControlsSection.tsx`) | Leaf component, consumed as-is |
| `TechnicalConfigSection.tsx` | Leaf component, consumed as-is |
| `SkillPicker.tsx` | Leaf component, consumed as-is |
| `ModelSelectionFields.tsx` | Leaf component, consumed as-is |
| `form-validation.ts` | Consumed by the body, not changed |
| `style-mapping.ts` | Create-shell only, not changed |
| `derive-capability-mode.ts` | Create-shell only, not changed |
| `AgentDetailPage.tsx` | Consumer of `EditAgentModal`, props unchanged |

## Invariants

1. **One `AgentFormState` type.** Both shells convert to/from it. No second field list exists.
2. **Validation lives in the body, once.** `validateCreateAgentForm`, the handler trio, and `ADVANCED_FIELD_TAB` exist in `AgentFormBody` only.
3. **Differences are slots, never mode flags.** The body has zero knowledge of create vs edit.
4. **No new dependencies.** All imports are already in the dep graph.
5. **No behavioural change to either form.** Same fields, same validation, same submit payloads. This is a pure structural refactor.

---

## Outstanding Issues (post-implementation)

### [AgentFormBody] Double validation on blur (MEDIUM)
`validateCreateAgentForm` runs twice on blur: once in `AgentFormBody.handleFieldBlur` (for auto-expand) and once in the shell's `validateFieldOnBlur` callback (for error state). Violates plan invariant "Validation lives in the body, once." Fix: return result from body to shell or move error state into body.

### [AgentFormBody] Venue derivation inconsistency (MEDIUM)
`AgentFormBody.handleFieldBlur` derives venue conditionally (live/shadow → `'connected'`, else `''`) while shells pass their own venue. Fix: add `venueOverride` prop to `AgentFormBody`.

### [AgentFormBody] `hasBotManagementSkill` computed in both shell and body (MEDIUM)
Both `EditAgentModal` and `AgentFormBody` independently compute `skillIds.includes('bot-management')`. Fix: pass as prop from shell to body.

### [CreateAgentFlow] Review button doesn't expand Advanced Settings for tab-hidden errors (MEDIUM)
When Review button validation finds errors in a collapsed Advanced Settings tab, the user sees nothing. Fix: expose imperative `expandTabForError` from `AgentFormBody` or add `expandTabSeq`/`errorTabIdx` props.

### [ADVANCED_FIELD_TAB] Entries without corresponding validation (LOW)
`dailyLossLimit`, `maxSlippageBps`, `stopLossCooldownSecs`, `openPositionEscalationToJudgePolicy` mapped to tab 2 but `validateCreateAgentForm` has no validation for them. Pre-existing issue from original code.

### [AgentFormBody] `isAdmin` prop unused (LOW)
Accepted in props but never read by the body. Forward-looking — may be needed for body-level admin gating.

### [AgentFormBody] Inline style objects recomputed on every render (LOW)
`fieldGap`, `errorStyle`, `helperStyle` are plain objects created each render. Could extract to module-level constants.
