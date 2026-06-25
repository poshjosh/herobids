# Follow up to docs/features/2026/06/24/002-advanced-settings-tabs/001-plan.md

We implemented docs/features/2026/06/24/002-advanced-settings-tabs/001-plan.md

The Scope was: "Apply to both Create (AgentsPage) and Edit (EditAgentModal) forms."

It seems the edit agent form did not benefit. Investigate and advise

## Findings: Why EditAgentModal did not benefit from the Advanced Settings Tabs

The plan explicitly states: **"Scope — Apply to both Create (AgentsPage) and Edit (EditAgentModal) forms."** While the tab *structure* was applied to `EditAgentModal` (the `<AdvancedSettingsSection>` with its four tab slots is present), the Edit form is missing the entire **validation and error-guided tab navigation** infrastructure that makes the tab UX useful in the Create form.

### What the Create form (AgentsPage) has that Edit does not:

#### 1. No validation framework at all

`AgentsPage` imports and uses `validateCreateAgentForm` from form-validation.ts, which validates:
- `maxOpenPositions` (must be integer ≥1, ≤ platform cap)
- `maxPositionSizePct` (0–100, ≤ platform cap)
- `stopLossPct` (0–100, ≤ platform cap)
- `tickIntervalMins` (≥1 minute, whole number)
- `capital` (required when trading, positive number)
- `venue` (required for live/shadow modes)

`EditAgentModal` has **zero** equivalent. There's no import of `validateCreateAgentForm` (or any validation function), no `formErrors` state variable, and no `ValidationConstraints` computed from `riskDefaultsQuery`. The variable `technicalConfigInvalid` is **hardcoded to `false`** on line 127 — so technical config is never validated.

#### 2. No error-guided tab navigation

`AgentsPage` defines:
```ts
const ADVANCED_FIELD_TAB: Record<string, number> = { ... }; // maps field → tab index
const [advancedExpandSeq, setAdvancedExpandSeq] = useState(0);
const [advancedErrorTabIdx, setAdvancedErrorTabIdx] = useState(2);
```
And passes `expandSeq={advancedExpandSeq}` and `errorTabIdx={advancedErrorTabIdx}` to `<AdvancedSettingsSection>`. When a field in a non-active tab fails validation, `bumpAdvancedExpand()` auto-expands the Advanced Settings section **and switches to the correct tab**.

`EditAgentModal` passes **neither** `expandSeq` nor `errorTabIdx`:
```tsx
<AdvancedSettingsSection
  aiConfig={...}
  skills={null}
  tradingSetup={...}
  strategy={...}
/>
```

#### 3. No field-level validation props wired to child components

`AgentsPage` passes `fieldErrors`, `onClearFieldError`, and `onBlurField` to both `AgentControlsSection` and `TradingGuardrailsFields`. This enables:
- Inline error messages under invalid fields (e.g., "Stop loss cannot exceed 100%")
- Error clearing when the user starts typing
- On-blur validation triggering tab auto-navigation

`EditAgentModal` does not pass any of these props. Compare:

| Component | Create (AgentsPage) | Edit (EditAgentModal) |
|-----------|---------------------|----------------------|
| `AgentControlsSection` | `fieldErrors`, `onClearFieldError`, `onBlurField` passed | **None passed** |
| `TradingGuardrailsFields` | `fieldErrors`, `onClearFieldError`, `onBlurField` passed | **Only `defaults` and `onChange`** |

#### 4. Submit-time validation is minimal

`AgentsPage` submit: runs full `validateCreateAgentForm` + blocks submission if `Object.keys(formErrors).length > 0`.

`EditAgentModal` submit: only checks `tickIntervalError != null`, `!form.name.trim()`, `!form.prompt.trim()`, and `modelOverrideEnabled` completeness. **No guardrail validation at all** — a user can submit `maxOpenPositions: "-5"` or `stopLossPct: "999"` and it goes straight to the API.

### Visual comparison

| Capability | Create (AgentsPage) | Edit (EditAgentModal) |
|---|---|---|
| Tab layout rendered? | ✅ Yes | ✅ Yes |
| Validation on trading guardrails? | ✅ Full (blur + submit) | ❌ None |
| Inline error messages in AI/Trading tabs? | ✅ Yes | ❌ None |
| Auto-expand Advanced on error? | ✅ Yes | ❌ None |
| Auto-switch tab to error field? | ✅ Yes | ❌ None |
| Technical config validation? | ✅ Via `validateCreateAgentForm` | ❌ `technicalConfigInvalid` hardcoded `false` |

### What needs to be added to EditAgentModal

To bring EditAgentModal up to parity, the following would need to be added:

1. **Import `validateCreateAgentForm`** and compute `validationConstraints` from `riskDefaultsQuery`
2. **Add `formErrors` state** (`Record<string, string>`)
3. **Add `advancedExpandSeq` / `advancedErrorTabIdx` state** and the `ADVANCED_FIELD_TAB` mapping
4. **Wire `expandSeq` / `errorTabIdx`** to `<AdvancedSettingsSection>`
5. **Pass `fieldErrors` / `onClearFieldError` / `onBlurField`** to `AgentControlsSection` and `TradingGuardrailsFields`
6. **Call `validateCreateAgentForm`** on submit (or write an edit-specific variant) and block submission on errors
7. **Remove the `technicalConfigInvalid = false` hardcode** and actually validate the technical config