# Plan: Unified Agent Create/Edit UI

Extend the agent creation and editing UI to support the new unified agent model
(intelligence + technical capabilities). Add a persistent "Create AI Agent" action
to the sidebar. Intelligence is pre-selected by default.

**Preset awareness:** Indicator presets defined here should be designed as plain
config objects extractable to a shared presets registry, to maintain parity with
the forthcoming bot mechanical strategy presets
(`docs/features/pending/rich-strategy-parity`).

---

## What Changes

### Entry points (no new pages)
- Sidebar: a "Create AI Agent" button/action below the agents nav item
- `AgentsPage` header: existing "New Agent" button unchanged (same form, same default)
- Empty state CTA: unchanged
- All three open the same `CreateAgentFlow` modal with intelligence pre-selected

### Create/Edit form
- Add **capability selection** (intelligence / technical / both) — intelligence pre-selected
- Add **technical config section** (shown when technical selected) with indicator presets
- Update form state, payloads, API schemas, and validation

---

## DONE: Phase 1 — API schema updates

**Files:** `apps/api/src/routes/agents.ts`

The current `CreateAgentSchema` and `UpdateAgentSchema` do not include `technical`
config. This must be added before the UI can send or receive it.

### Checklist

- [ ] Import `TechnicalConfigSchema` from `@herobids/domain`
- [ ] Add `technical: TechnicalConfigSchema.optional()` to `CreateAgentSchema`
- [ ] Add `technical: TechnicalConfigSchema.nullable().optional()` to `UpdateAgentSchema`
- [ ] In the create handler: persist `technical` into the agent's `unifiedConfig`
  JSONB column (already added by Phase 6 migration)
- [ ] In the update handler: persist `technical` into `unifiedConfig` if provided
  (merge, do not replace unrelated fields)
- [ ] In the GET agent response: include `technical` from `unifiedConfig` in the
  returned agent object
- [ ] Add `technical` to the API client type (`Agent`) in `apps/web/src/lib/api-client.ts`
- [ ] Tests: POST with technical config persists it; PATCH with `technical: null`
  removes it; GET returns it

---

## PENDING: Phase 2 — Indicator preset definitions

**File:** `apps/web/src/features/agents/technical-presets.ts` (new)

Define named preset configs as plain objects. Kept separate from UI so they can
later be shared with the bot mechanical strategy preset registry.

### Presets

```typescript
export type TechnicalPresetId = 'momentum-breakout' | 'mean-reversion' | 'conservative' | 'custom';

export interface TechnicalPreset {
  id: TechnicalPresetId;
  labelKey: string;       // i18n key
  descriptionKey: string; // i18n key
  patch: Partial<TechnicalConfigFormState> | null;
}
```

**Momentum Breakout** — trend-following, RSI healthy range, MACD crossover, strong
volume, S/R breakout, scanInterval 60s
```
signalBias: 'trend-following'
indicators.rsi: enabled, period 14, healthyMin 40, healthyMax 70, overbought 80
indicators.macd: enabled, fast 12, slow 26, signal 9
indicators.volume: enabled, strongRatio 1.5
indicators.supportResistance: enabled, lookback 50, breakoutThreshold 0.005
indicators.choch: disabled
confidence.minConfidence: 0.50
scanIntervalMs: 60_000
candles: interval '15m', limit 100
```

**Mean Reversion** — opposite bias, RSI oversold entry, CHOCH bearish = buy signal
```
signalBias: 'mean-reverting'
indicators.rsi: enabled, weakBelow 30, overbought 75
indicators.macd: enabled
indicators.volume: enabled
indicators.choch: enabled, rejectOnBearish false
confidence.minConfidence: 0.45
scanIntervalMs: 60_000
candles: interval '15m', limit 100
```

**Conservative** — high-confidence only, more filters, slower scan
```
signalBias: 'trend-following'
indicators.rsi: enabled, healthyMin 45, healthyMax 65, overbought 75
indicators.macd: enabled
indicators.volume: enabled, strongRatio 1.8
indicators.choch: enabled, confirmBars 3
confidence.minConfidence: 0.60, minReasons: 3
scanIntervalMs: 300_000
candles: interval '1H', limit 100
```

**Custom** — no defaults, user fills in everything

### Checklist

- [ ] Create `technical-presets.ts` with `TECHNICAL_PRESETS` array and
  `getTechnicalPresetConfig(id)` helper
- [ ] Each preset's `patch` is a `Partial<TechnicalConfigFormState> | null` — deep-merged with current form state when applied. Custom preset has `patch: null` (preserves current values).
- [ ] Export `TechnicalPresetId` and `TECHNICAL_PRESETS` from the file
- [ ] Unit test: applying each preset produces a valid `TechnicalConfig`

---

## PENDING: Phase 3 — `TechnicalConfigSection` component

**File:** `apps/web/src/features/agents/TechnicalConfigSection.tsx` (new)

A self-contained form section rendered when technical capability is selected.
Takes `value: TechnicalConfigFormState` and `onChange` callback.

### Sub-sections

**Preset selector** (always visible when section is open)
- Horizontal card row: Momentum Breakout | Mean Reversion | Conservative | Custom
- Selecting a preset fills the fields below; selecting Custom preserves current values
- Active preset highlighted

**Discovery filters** (always shown, required fields)
```
Venue             [select: hyperliquid | jupiter]
Venue type        [select: orderbook | swap]  — auto-filled by venue
Min volume (USD)  [number input, optional]
Min liquidity     [number input, optional, shown for swap only]
Networks          [multi-select tags, shown for swap only]
Symbol allowlist  [textarea / tag input, optional — "only trade these"]
Exclude symbols   [textarea / tag input, optional]
```

**Scan settings** (collapsible, "Advanced" toggle)
```
Scan interval     [number input, minutes] — converted to ms
Batch size        [number input, 1–50]
Candle interval   [select: 5m | 15m | 1H | 4H | 1D]
Candle lookback   [number input, 20–500]
Signal bias       [toggle: Trend-following | Mean-reverting]
```

**Indicator toggles** (collapsible per-indicator, expanded by default for enabled)
Each indicator has an on/off toggle. When on, advanced params expand inline.

```
RSI       [toggle] → period, healthyMin/Max, overbought, weakBelow
MACD      [toggle] → fast, slow, signal
Volume    [toggle] → strongRatio, weakRatio, recentBars, avgBars
CHOCH     [toggle] → swingLookback, minSwingPct, confirmBars, rejectOnBearish
S/R       [toggle] → lookback, breakoutThreshold
```

**Confidence weights** (collapsible, "Tune weights" toggle, pre-collapsed)
Shows numeric inputs for each weight + minConfidence + minReasons.

### Form state type

```typescript
export interface TechnicalConfigFormState {
  preset: TechnicalPresetId;
  filters: {
    venue: string;
    venueType: 'orderbook' | 'swap' | '';
    minVolume24hUsd: string;
    minLiquidityUsd: string;
    networks: string[];
    symbols: string[];
    excludeSymbols: string[];
  };
  candles: {
    interval: '5m' | '15m' | '1H' | '4H' | '1D';
    limit: string;
  };
  signalBias: 'trend-following' | 'mean-reverting';
  scanIntervalMins: string;
  scanBatchSize: string;
  indicators: {
    rsi: { enabled: boolean; period: string; healthyMin: string; healthyMax: string; overbought: string; weakBelow: string };
    macd: { enabled: boolean; fast: string; slow: string; signal: string };
    volume: { enabled: boolean; strongRatio: string; weakRatio: string; recentBars: string; avgBars: string };
    choch: { enabled: boolean; swingLookback: string; minSwingPct: string; confirmBars: string; rejectOnBearish: boolean };
    supportResistance: { enabled: boolean; lookback: string; breakoutThreshold: string };
  };
  confidence: {
    rsiWeight: string; macdCrossoverWeight: string; macdIncreasingWeight: string;
    volumeWeight: string; breakoutWeight: string; chochBullishWeight: string;
    chochBearishPenalty: string; priceActionWeight: string;
    minConfidence: string; minReasons: string;
  };
}
```

### Helper functions (in `technical-config-helpers.ts`)

- `defaultTechnicalConfigFormState(): TechnicalConfigFormState`
- `applyPreset(preset: TechnicalPresetId, current: TechnicalConfigFormState): TechnicalConfigFormState`
- `technicalFormStateToPayload(state: TechnicalConfigFormState): TechnicalConfig | null`
  — returns null if venue not set (incomplete)
- `technicalConfigToFormState(config: TechnicalConfig): TechnicalConfigFormState`
  — for loading existing config into the edit form

### Checklist

- [ ] Create `technical-config-helpers.ts` with the four helpers above
- [ ] Unit tests for `technicalFormStateToPayload` and `technicalConfigToFormState`
  (round-trip test)
- [ ] Create `TechnicalConfigSection.tsx` — controlled component
- [ ] Preset selector: cards with label + description
- [ ] Discovery filters section (always visible)
- [ ] Scan settings collapsible
- [ ] Indicator toggles with inline parameter expansion
- [ ] Confidence weights collapsible (pre-collapsed)
- [ ] Validation: venue required when technical is enabled; show inline errors

---

## PENDING: Phase 4 — Capability selector component

**File:** `apps/web/src/features/agents/CapabilitySelector.tsx` (new)

Renders three toggle cards:

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Intelligence  │  │    Technical    │  │      Both       │
│   (AI Agent)    │  │  (Automation)   │  │  (AI + Rules)   │
│ LLM reasoning   │  │ Rule-based scan │  │ Pre-filter then │
│ $$$ / decision  │  │ ~$0 / decision  │  │ LLM confirms    │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

Props:
```typescript
interface CapabilitySelectorProps {
  value: CapabilityMode;
  onChange: (mode: CapabilityMode) => void;
}

type CapabilityMode = 'intelligence' | 'technical' | 'both';
```

### Checklist

- [ ] Create `CapabilitySelector.tsx`
- [ ] Three cards, visually distinct from each other
- [ ] Selected card has border highlight + check mark
- [ ] Cost label for each ("LLM cost", "No LLM cost", "Reduced LLM cost")
- [ ] Accessible: keyboard navigation between cards, `aria-pressed`

---

## PENDING: Phase 5 — Create form updates

**File:** `apps/web/src/features/agents/AgentsPage.tsx`

### IntentState additions

```typescript
interface IntentState {
  // existing fields unchanged...
  capabilityMode: CapabilityMode;         // new — default 'intelligence'
  technicalConfig: TechnicalConfigFormState; // new
}
```

### Form changes

**Step: `intent`**

1. Add `CapabilitySelector` at the top of the form, above name/goal
   - Default: `'intelligence'`
2. Show/hide sections based on `capabilityMode`:
   - `intelligence` selected → show existing LLM fields (model, tick interval, goal)
   - `technical` selected → hide LLM fields; show `TechnicalConfigSection`
   - `both` selected → show both
3. **Skills**: when `capabilityMode === 'technical'` only, hide the skill preset
   picker entirely (technical-only agents have no LLM to call skills)
4. **Goal field**: relabel to "Instructions / Goal" for `both` mode; hide for
   `technical`-only (no LLM = no goal prompt)

### Payload changes

- Update `buildCreateAgentPayload` to include `technical` from form state
- When `capabilityMode === 'technical'`: omit `prompt`, `provider`, `lightModel`,
  `heavyModel`, `tickIntervalMs` from payload
- When `capabilityMode === 'intelligence'`: omit `technical` from payload
- When `capabilityMode === 'both'`: include all

### Checklist

- [ ] Add `capabilityMode` and `technicalConfig` to `IntentState`
- [ ] Default `capabilityMode: 'intelligence'`
- [ ] Render `CapabilitySelector` in step `intent`
- [ ] Conditional rendering of intelligence / technical sections
- [ ] Hide skill picker for technical-only
- [ ] Update `buildCreateAgentPayload` in `agent-payloads.ts`
  — add `technical?: TechnicalConfig` to `CreateAgentIntentPayloadInput`
- [ ] Update `CreateAgentSchema` API call to include `technical`
- [ ] Review step: show capability mode summary ("Technical scanning + Intelligence")
- [ ] Update i18n keys (see Phase 8)
- [ ] Tests: `agent-payloads.test.ts` — payload includes technical when set

---

## PENDING: Phase 6 — Edit form updates

**File:** `apps/web/src/features/agents/EditAgentModal.tsx`

### FormState additions

```typescript
interface FormState {
  // existing fields unchanged...
  capabilityMode: CapabilityMode;
  technicalConfig: TechnicalConfigFormState;
}
```

### Init from existing agent

- Derive `capabilityMode` from `initialData`:
  - has `technical` → 'technical' or 'both' (depending on `intelligence` presence)
  - has only intelligence config (current agents) → 'intelligence'
- Load `technicalConfig` via `technicalConfigToFormState(initialData.technical)`
  if present, else `defaultTechnicalConfigFormState()`

### Change semantics

- Switching capabilityMode from `intelligence` → `technical`: warn user that LLM
  config will be ignored at runtime (the agent's goal/prompt stays in DB but won't
  be used). No data loss.
- Switching capabilityMode from `technical` → `intelligence`: technical section
  is excluded from payload (equivalent to removing it)
- The API's `UpdateAgentSchema` accepts `technical: null` to remove it

### Payload changes

- Update `buildUpdateAgentPayload` to include `technical`
- When capabilityMode excludes technical: send `technical: null` in the payload
  to remove it

### Checklist

- [ ] Add `capabilityMode` and `technicalConfig` to `FormState`
- [ ] Derive initial values from `initialData`
- [ ] Add `CapabilitySelector` to edit form
- [ ] Show `TechnicalConfigSection` when appropriate
- [ ] Update `buildUpdateAgentPayload` in `agent-payloads.ts`
  — add `technical?: TechnicalConfig | null` to `UpdateAgentPayloadInput`
- [ ] Warn if switching away from intelligence (modal or inline notice)
- [ ] Tests: `edit-agent-models.test.ts` — payload includes/removes technical

---

## PENDING: Phase 7 — Sidebar "Create AI Agent" action

**File:** `apps/web/src/app/layout/Sidebar.tsx`

Add a button immediately below the "AI Agents" nav item that navigates to
`/agents?create=1`. Reuses the existing URL-based modal trigger in `AgentsPage`.

### Design

```
⊡ AI Agents                    ← existing nav link
  + New AI Agent               ← new action button, indented, muted style
```

The button is:
- Indented 8px relative to nav items (visual hierarchy)
- Smaller text (12px), muted color, "+" prefix
- Not a nav item (doesn't highlight as active)
- On click: `navigate('/agents?create=1')`
- On mobile: also calls `onClose()` to close the sidebar overlay

### Implementation

```tsx
function SidebarAction({ label, path, onNavigate }: { label: string; path: string; onNavigate?: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => { void navigate(path); onNavigate?.(); }}
      style={{ /* muted small button */ }}
    >
      + {label}
    </button>
  );
}
```

Add to `NAV_ITEMS` group, directly after the agents item:

```tsx
<NavItem path="/agents" label="AI Agents" icon="⊡" active={...} onNavigate={onClose} />
<SidebarAction label={intl.formatMessage({ id: 'nav.createAgent' })} path="/agents?create=1" onNavigate={onClose} />
```

### i18n key

`'nav.createAgent': 'New AI Agent'`

### Checklist

- [ ] Add `SidebarAction` component to `Sidebar.tsx`
- [ ] Add after agents nav item in `NAV_ITEMS` block
- [ ] Mobile: calls `onClose` after navigation
- [ ] Add `nav.createAgent` i18n key to `en.ts` and all locale files
- [ ] Accessibility: `aria-label` on the button

---

## PENDING: Phase 8 — i18n strings

**File:** `apps/web/src/app/i18n/locales/en.ts`

New keys to add:

```typescript
// Capability selector
'agents.capability.title': 'How should your agent operate?',
'agents.capability.intelligence.label': 'Intelligence',
'agents.capability.intelligence.description': 'LLM reasoning — the agent thinks and decides.',
'agents.capability.intelligence.cost': 'LLM cost per decision',
'agents.capability.technical.label': 'Technical',
'agents.capability.technical.description': 'Rule-based indicator scanning. No LLM.',
'agents.capability.technical.cost': 'No LLM cost',
'agents.capability.both.label': 'Intelligence + Technical',
'agents.capability.both.description': 'Indicators pre-filter candidates, LLM makes final call.',
'agents.capability.both.cost': 'Reduced LLM cost',

// Technical config section
'agents.technical.title': 'Technical Configuration',
'agents.technical.preset.label': 'Strategy preset',
'agents.technical.preset.momentumBreakout.label': 'Momentum Breakout',
'agents.technical.preset.momentumBreakout.description': 'Trend-following: RSI health, MACD crossover, volume confirmation',
'agents.technical.preset.meanReversion.label': 'Mean Reversion',
'agents.technical.preset.meanReversion.description': 'Buy oversold dips, CHOCH reversals',
'agents.technical.preset.conservative.label': 'Conservative',
'agents.technical.preset.conservative.description': 'High confidence threshold, slower scan, fewer entries',
'agents.technical.preset.custom.label': 'Custom',
'agents.technical.preset.custom.description': 'Configure indicators manually',

// Discovery filters
'agents.technical.filters.title': 'Discovery Filters',
'agents.technical.filters.venue': 'Venue',
'agents.technical.filters.venueType': 'Venue type',
'agents.technical.filters.minVolume': 'Min 24h volume (USD)',
'agents.technical.filters.minLiquidity': 'Min liquidity (USD)',
'agents.technical.filters.symbols': 'Symbol allowlist',
'agents.technical.filters.symbolsHelp': 'Only scan these symbols. Leave blank to scan all.',
'agents.technical.filters.excludeSymbols': 'Exclude symbols',
'agents.technical.filters.networks': 'Networks',

// Scan settings
'agents.technical.scan.title': 'Scan Settings',
'agents.technical.scan.interval': 'Scan interval (minutes)',
'agents.technical.scan.batchSize': 'Batch size',
'agents.technical.scan.candleInterval': 'Candle interval',
'agents.technical.scan.candleLimit': 'Candle lookback',
'agents.technical.scan.signalBias': 'Signal bias',
'agents.technical.scan.signalBias.trendFollowing': 'Trend-following',
'agents.technical.scan.signalBias.meanReverting': 'Mean-reverting',

// Indicators
'agents.technical.indicators.title': 'Indicators',
'agents.technical.indicators.rsi': 'RSI',
'agents.technical.indicators.macd': 'MACD',
'agents.technical.indicators.volume': 'Volume trend',
'agents.technical.indicators.choch': 'CHOCH (change of character)',
'agents.technical.indicators.supportResistance': 'Support/Resistance',

// Sidebar
'nav.createAgent': 'New AI Agent',
```

### Checklist

- [ ] Add all new keys to `en.ts`
- [ ] Add matching keys to `hi.ts` (Hindi locale) — can be same string initially
  with TODO for translation

---

## PENDING: Phase 9 — Tests

**Files:**
- `apps/web/src/features/agents/technical-config-helpers.test.ts` (new)
- `apps/web/src/features/agents/technical-presets.test.ts` (new)
- `apps/web/src/features/agents/agent-payloads.test.ts` (extend)
- `apps/api/src/routes/agents.test.ts` (extend)

### Test cases

**`technical-config-helpers.test.ts`**
- `technicalFormStateToPayload` returns null when venue not set
- `technicalFormStateToPayload` returns valid config with all fields
- `technicalConfigToFormState` round-trip: config → form → payload ≈ original
- `applyPreset('momentum-breakout', ...)` produces expected signalBias and indicator config
- `applyPreset('custom', ...)` preserves current form values

**`technical-presets.test.ts`**
- Each preset config, when passed through `technicalFormStateToPayload`, produces a
  config that passes `TechnicalConfigSchema.parse()`

**`agent-payloads.test.ts`** (extend)
- `buildCreateAgentPayload` with `capabilityMode: 'technical'` includes `technical`
  and omits `provider`/`lightModel`/`heavyModel`
- `buildCreateAgentPayload` with `capabilityMode: 'intelligence'` omits `technical`
- `buildUpdateAgentPayload` with capabilityMode switching to 'intelligence' sends
  `technical: null`

**`agents.test.ts`** (extend)
- `POST /agents` with `technical` config persists it to `unifiedConfig`
- `PATCH /agents/:id` with `technical: null` removes it
- `GET /agents/:id` response includes `technical` from `unifiedConfig`

---

## Definition of Done

- [ ] `POST /agents` and `PATCH /agents/:id` accept and persist `technical` config
- [ ] `GET /agents/:id` returns `technical` config
- [ ] Create form shows capability selector with intelligence pre-selected
- [ ] Technical config section renders with preset selector and all sub-sections
- [ ] Applying a preset fills form fields correctly
- [ ] Creating a technical-only agent omits LLM fields from payload
- [ ] Edit form loads existing `technical` config and allows modification
- [ ] "New AI Agent" button appears in sidebar below agents nav item
- [ ] Clicking sidebar button opens the create modal (intelligence pre-selected)
- [ ] All i18n keys present in `en.ts` and `hi.ts`
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Outstanding Issues

_All previously outstanding issues have been resolved (2026-06-16)._

