# 021 — Bot Create: Custom Strategy Config

**Created:** 2026-07-07
**Status:** draft

---

## Problem

The Create Bot form offers only named strategy presets (momentum, range, swing, scalper, contrarian, DCA). Users who want to tweak individual parameters — stop loss %, position size, candle interval, risk limits — have no path except editing the JSON config after creation, which is not user-accessible.

The agent create form already solves this: `StrategyPresetSelector` has a "Custom" card that reveals `TechnicalConfigSection`, a structured editor with labeled dropdowns and number inputs. The bot form opts out of this by passing `showCustom={false}` to the same component.

The goals for both forms are the same: accessible to everyone, no JSON knowledge required.

---

## Goal

Add a "Custom" card to the bot strategy preset grid. When selected, reveal a structured `BotCustomConfigSection` component that lets the user configure all bot strategy and risk parameters through plain labeled fields — identical UX model to the agent form's custom mode.

---

## Scope

### Out of scope
- Blueprint save/reference flow (deferred to the full Blueprints feature, feature 015/020).
- LLM and Hybrid decision modes (initial version only exposes `mechanical`; `llm`/`hybrid` can be added later).
- Indicator-level parameter editing (RSI, MACD, volume weights, etc.) — presets handle those; custom exposes the high-level knobs only.
- Edit-bot form — this plan covers creation only.
- **DCA strategy type in custom mode** — DCA has no entry/exit signals and its own parameter shape (buy interval, order amount) that is outside the scope of this form. DCA remains available via named presets only.

---

## Types

### `BotCustomConfigFormState`

New type for the structured custom config. Lives in `apps/web/src/features/bots/BotCustomConfigSection.tsx` or a co-located `bot-custom-config-helpers.ts`.

```ts
export interface BotCustomConfigFormState {
  // Strategy identity
  strategyType: 'momentum' | 'range' | 'contrarian' | 'swing' | 'scalper';
  decisionMode: 'mechanical';           // only mechanical in v1; llm/hybrid deferred

  // Signal interpretation (mechanical params)
  signalBias: 'trend-following' | 'mean-reverting';
  candleInterval: '5m' | '15m' | '1H' | '4H' | '1D';
  candleLimit: string;                  // controlled number input → parseInt

  // Exit targets (mechanical params — both required for mechanical strategy)
  stopLossPct: string;
  takeProfitPct: string;
  trailingStopPct: string;              // empty string = null (no trailing stop)

  // Position sizing (mechanical params)
  positionSize: string;
  positionSizeMode: 'fixed' | 'percent_equity';

  // Risk guardrails (all optional — only sent when non-empty)
  maxPositionSizePct: string;
  maxOpenPositions: string;
  dailyMaxLossPct: string;
  stopLossMaxUnrealizedLossPct: string;
}

export const defaultBotCustomConfig: BotCustomConfigFormState = {
  strategyType: 'momentum',
  decisionMode: 'mechanical',
  signalBias: 'trend-following',
  candleInterval: '15m',
  candleLimit: '48',
  stopLossPct: '',
  takeProfitPct: '',
  trailingStopPct: '',
  positionSize: '100',
  positionSizeMode: 'percent_equity',
  maxPositionSizePct: '',
  maxOpenPositions: '',
  dailyMaxLossPct: '',
  stopLossMaxUnrealizedLossPct: '',
};
```

### Expand `CreateBotForm` in `BotsPage.tsx`

```ts
interface CreateBotForm {
  connectionId: string;
  strategyPreset: string;             // 'custom' | preset key | ''
  executionMode: ExecutionModeValue;
  symbol: string;
  customConfig: BotCustomConfigFormState;  // ← new
}
```

---

## Implementation Checklist

### Phase 1 — New `BotCustomConfigSection` component

**File:** `apps/web/src/features/bots/BotCustomConfigSection.tsx`

- [ ] **1.1** Define `BotCustomConfigFormState` and `defaultBotCustomConfig` (can be in this file or a co-located helpers file).

- [ ] **1.2** Define `BotCustomConfigSectionProps`:

  ```ts
  interface BotCustomConfigSectionProps {
    value: BotCustomConfigFormState;
    onChange: (patch: Partial<BotCustomConfigFormState>) => void;
    isSwapVenue: boolean;
  }
  ```

- [ ] **1.3** Render the following sections in order, matching the visual style of `TechnicalConfigSection` (section headers, bordered cards, gap-10/gap-12 flex columns):

  **Section: Strategy**
  | Field | Control | Notes |
  |---|---|---|
  | Strategy type | `<select>` | Options: momentum, range, contrarian, swing, scalper (DCA excluded — preset only) |
  | Signal bias | 2-button toggle | Trend-following / Mean-reverting |
  | Candle interval | `<select>` | 5m / 15m / 1H / 4H / 1D |
  | Candle limit | `<input type="number">` | min=20, max=500 |

  **Section: Exit Targets**
  | Field | Control | Notes |
  |---|---|---|
  | Stop loss % | `<input type="number">` | Required. min=0, max=100 |
  | Take profit % | `<input type="number">` | Required. min=0 |
  | Trailing stop % | `<input type="number">` | Optional. Empty = no trailing stop |

  **Section: Position Sizing**
  | Field | Control | Notes |
  |---|---|---|
  | Position size | `<input>` | Decimal string |
  | Size mode | 2-button toggle | Fixed / % of equity |

  **Section: Risk Guardrails** (all optional — shown with placeholder "use default")
  | Field | Control | Notes |
  |---|---|---|
  | Max position size % | `<input type="number">` | optional |
  | Max open positions | `<input type="number">` | optional |
  | Daily loss limit % | `<input type="number">` | optional |
  | Max unrealized loss % | `<input type="number">` | optional |

- [ ] **1.4** For swap venues (`isSwapVenue=true`): hide the Signal bias, candle interval, and candle limit fields, and show a notice below the strategy type selector:

  > "Swap venue detected — candle-based parameters are not applicable. Configure position sizing and risk limits only."

  Do not block strategy selection outright; the API is the authoritative validator. The notice is informational.

---

### Phase 2 — Wire into `CreateBotModal`

**File:** `apps/web/src/features/bots/BotsPage.tsx`

- [ ] **2.1** Import `BotCustomConfigSection`, `BotCustomConfigFormState`, `defaultBotCustomConfig`.

- [ ] **2.2** Expand `CreateBotForm` interface with `customConfig: BotCustomConfigFormState`.

- [ ] **2.3** Add `customConfig: defaultBotCustomConfig` to the initial `useState`.

- [ ] **2.3a** Add a helper `presetToCustomConfig(preset: PresetFromApi): BotCustomConfigFormState` that maps a fetched preset's strategy/risk params to `BotCustomConfigFormState`. This is used to pre-populate the custom editor so users start from a familiar baseline rather than blank fields:

  ```ts
  function presetToCustomConfig(preset: PresetFromApi): BotCustomConfigFormState {
    const params = (preset.strategy.params ?? {}) as Record<string, unknown>;
    return {
      ...defaultBotCustomConfig,
      strategyType: (preset.strategy.type as BotCustomConfigFormState['strategyType']) ?? 'momentum',
      signalBias: (params['signalBias'] as BotCustomConfigFormState['signalBias']) ?? 'trend-following',
      candleInterval: (params['candleInterval'] as BotCustomConfigFormState['candleInterval']) ?? '15m',
      candleLimit: String(params['candleLimit'] ?? 48),
      stopLossPct: String(params['stopLossPct'] ?? ''),
      takeProfitPct: String(params['takeProfitPct'] ?? ''),
      trailingStopPct: params['trailingStopPct'] != null ? String(params['trailingStopPct']) : '',
      positionSize: String(params['positionSize'] ?? '100'),
      positionSizeMode: (params['positionSizeMode'] as BotCustomConfigFormState['positionSizeMode']) ?? 'percent_equity',
      maxPositionSizePct: preset.risk?.maxPositionSizePct != null ? String(preset.risk.maxPositionSizePct) : '',
    };
  }
  ```

- [ ] **2.4** Change `StrategyPresetSelector` from `showCustom={false}` to `showCustom={true}` (or remove the prop, since `true` is the default). Wire the `onChange` callback so that when the user selects `'custom'`, `customConfig` is pre-populated from the currently-displayed presets' first entry (or `defaultBotCustomConfig` if presets have not loaded):

  ```tsx
  onChange={(key) => {
    if (key === 'custom') {
      const seed = fetchedPresets[0];
      setForm((s) => ({
        ...s,
        strategyPreset: 'custom',
        customConfig: seed ? presetToCustomConfig(seed) : defaultBotCustomConfig,
      }));
    } else {
      setForm((s) => ({ ...s, strategyPreset: key }));
    }
  }}
  ```

- [ ] **2.5** After `<StrategyPresetSelector>`, add conditional rendering:

  ```tsx
  {form.strategyPreset === 'custom' && (
    <BotCustomConfigSection
      value={form.customConfig}
      onChange={(patch) => setForm((s) => ({ ...s, customConfig: { ...s.customConfig, ...patch } }))}
      isSwapVenue={isSwapVenue}
    />
  )}
  ```

- [ ] **2.6** Hide the strategy style tier `<select>` when `strategyPreset === 'custom'` — the style tier only controls which preset tier to fetch; it is meaningless in custom mode.

  ```tsx
  {form.strategyPreset !== 'custom' && (
    <div>
      <FieldLabel>Strategy style</FieldLabel>
      <select ...>...</select>
    </div>
  )}
  ```

- [ ] **2.7** Update `mutationFn` to branch on `strategyPreset`:

  ```ts
  mutationFn: () => {
    const venue = selectedConnection?.provider;
    if (!venue) throw new Error('Select a platform link before creating a bot');

    let config: Record<string, unknown>;

    if (form.strategyPreset === 'custom') {
      config = buildCustomBotConfig(form.customConfig, form.executionMode, venue, form.symbol);
    } else {
      const preset = fetchedPresets.find((p) => p.key === form.strategyPreset);
      if (!preset) throw new Error('Selected strategy preset not found');
      config = {
        strategy: preset.strategy,
        ...(preset.risk ? { risk: preset.risk } : {}),
        execution: { mode: form.executionMode },
        venue,
        symbol: form.symbol,
      };
    }

    return botsApi.create({ connectionId: form.connectionId, venue, symbol: form.symbol, config });
  },
  ```

- [ ] **2.8** Implement `buildCustomBotConfig` (local helper, private to the file):

  ```ts
  function buildCustomBotConfig(
    c: BotCustomConfigFormState,
    executionMode: string,
    venue: string,
    symbol: string,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      candleInterval: c.candleInterval,
      candleLimit: parseInt(c.candleLimit, 10),
      signalBias: c.signalBias,
      stopLossPct: parseFloat(c.stopLossPct),
      takeProfitPct: parseFloat(c.takeProfitPct),
      trailingStopPct: c.trailingStopPct ? parseFloat(c.trailingStopPct) : null,
      positionSize: c.positionSize,
      positionSizeMode: c.positionSizeMode,
    };

    const risk: Record<string, unknown> = {};
    if (c.maxPositionSizePct) risk['maxPositionSizePct'] = parseFloat(c.maxPositionSizePct);
    if (c.maxOpenPositions) risk['maxOpenPositions'] = parseInt(c.maxOpenPositions, 10);
    if (c.dailyMaxLossPct) risk['dailyMaxLossPct'] = parseFloat(c.dailyMaxLossPct);
    if (c.stopLossMaxUnrealizedLossPct) risk['stopLossMaxUnrealizedLossPct'] = parseFloat(c.stopLossMaxUnrealizedLossPct);

    return {
      strategy: {
        type: c.strategyType,
        decisionMode: c.decisionMode,
        params,
      },
      ...(Object.keys(risk).length > 0 ? { risk } : {}),
      execution: { mode: executionMode },
      venue,
      symbol,
    };
  }
  ```

  Note: DCA is not available in custom mode (out of scope). `decisionMode` is always `'mechanical'` in v1.

- [ ] **2.9** Update the Create button's `disabled` guard to also allow custom when required fields are present:

  ```tsx
  disabled={
    mutation.isPending
    || presetsQuery.isLoading
    || !form.connectionId
    || !form.symbol.trim()
    || (form.strategyPreset !== 'custom' && !form.strategyPreset)
    || (form.strategyPreset === 'custom' && (
      !form.customConfig.stopLossPct
      || !form.customConfig.takeProfitPct
      || !form.customConfig.positionSize
    ))
  }
  ```

---

### Phase 3 — Validation (inline, no separate file)

The bot form is simpler than the agent form — no multi-step flow, no "Review" page, no Zod-based frontend validation schema. Basic guards are sufficient:

- [ ] **3.1** `stopLossPct` and `takeProfitPct`: required for all strategies except DCA. Show an inline `<div style={errorStyle}>` below the field when the user blurs and the field is empty.

- [ ] **3.2** `positionSize`: required, must be a positive number string. Show error on blur.

- [ ] **3.3** All percentage fields: must be between 0 and 100 when present.

  These are the same patterns already used in `AgentControlsSection` and `AdvancedSettingsSection`. Copy the `errorStyle` and blur-triggered validation pattern from there.

---

### Phase 4 — Visual polish

- [ ] **4.1** Ensure section headers and field groups match the existing visual language in `TechnicalConfigSection.tsx` — bordered card containers, `sectionTitleStyle`, `FieldLabel`, `inputStyle` from `../../lib/ui.js`.

- [ ] **4.2** Add a short helper text below the custom section: "Your settings are not saved as a blueprint. To reuse this configuration, save it as a blueprint from the Blueprints page."

  Plain text only — no link. The Blueprints page (feature 015) does not exist yet.

- [ ] **4.3** When the user switches away from "Custom" back to a named preset, reset `customConfig` to `defaultBotCustomConfig` to avoid stale state.

---

## Acceptance Criteria

- [ ] "Custom" card appears in the strategy preset grid alongside named presets.
- [ ] Selecting "Custom" hides the strategy style tier selector and reveals `BotCustomConfigSection`.
- [ ] All custom fields are labeled inputs, dropdowns, or toggles — no JSON editor.
- [ ] DCA strategy type hides candle, signal bias, and exit-target fields.
- [ ] Swap venue hides candle/signal bias fields and shows a notice.
- [ ] Submitting a custom config creates a bot with the correct `strategy`, `risk`, and `execution` config; API validation (`BotConfigSchema`) passes.
- [ ] Submitting with missing required fields (stopLossPct, takeProfitPct, positionSize) is blocked with inline error messages.
- [ ] Switching back to a named preset re-shows the style selector and hides custom fields.
- [ ] `pnpm lint` passes (no TS errors).

---

## Resolved Design Decisions

| # | Decision |
|---|---|
| OQ-1 | Swap venues: hide candle/signal-bias fields and show a notice. Do not block strategy selection — the API is the authoritative validator. |
| OQ-2 | "Save as blueprint" helper text is plain text only. No link until the Blueprints page (feature 015) ships. |
| OQ-3 | DCA excluded from custom mode in v1. DCA parameters are outside the scope of `MechanicalParamsSchema`. DCA remains available via named presets only. |
| OQ-4 | When the user clicks "Custom", pre-populate `customConfig` from the first preset in the currently-loaded style tier. Falls back to `defaultBotCustomConfig` if presets have not loaded. |
