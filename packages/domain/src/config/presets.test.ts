import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  seedPresetCatalog,
  loadPresets,
  getPreset,
  listPresets,
} from './presets-loader.js';
import {
  agentStyleToPresetStyle,
  applyPresetToAgent,
  computePresetBehaviorVersion,
  extractBehaviorFields,
  AGENT_TECHNICAL_STRATEGY_TYPES,
  type PresetEntry,
} from './presets.js';

// The presets-loader module uses a module-level cache. Clear it between tests so
// each test gets a fresh seed.

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helper: re-import presets-loader module with a clean cache
// ---------------------------------------------------------------------------

async function freshPresets() {
  return await import('./presets-loader.js');
}

/** A minimal but realistic catalog payload (the `get_strategy_presets` shape). */
function catalogPayload(): unknown {
  const momentum = (stopLossPct: number, positionSize: string, minConfidence: number): PresetEntry => ({
    name: 'Momentum — Day',
    description: 'Day-trend following',
    strategy: {
      type: 'momentum',
      decisionMode: 'mechanical',
      params: {
        candleInterval: '1H',
        candleLimit: 24,
        stopLossPct,
        positionSize,
        signalBias: 'trend-following',
        indicators: { confidence: { minConfidence } },
      },
    },
  });
  const dca: PresetEntry = {
    name: 'DCA',
    description: 'Dollar-cost averaging',
    strategy: { type: 'dca', decisionMode: 'mechanical', params: { intervalMs: 86_400_000 } },
  };
  const scalper: PresetEntry = {
    name: 'Scalper',
    description: 'Scalping',
    strategy: { type: 'scalper', decisionMode: 'mechanical', params: { candleInterval: '1m' } },
  };
  const contrarian: PresetEntry = {
    name: 'Contrarian',
    description: 'Contrarian',
    strategy: { type: 'contrarian', decisionMode: 'mechanical', params: {} },
  };
  const range: PresetEntry = {
    name: 'Range',
    description: 'Range',
    strategy: { type: 'range', decisionMode: 'mechanical', params: {} },
  };
  const swing: PresetEntry = {
    name: 'Swing',
    description: 'Swing',
    strategy: { type: 'swing', decisionMode: 'mechanical', params: {} },
  };
  const momentumPosition: PresetEntry = {
    name: 'Momentum Position',
    description: 'Momentum position',
    strategy: { type: 'momentum-position', decisionMode: 'mechanical', params: {} },
  };
  const economy = [
    { key: 'momentum', entry: momentum(2, '2', 0.7) },
    { key: 'dca', entry: dca },
    { key: 'scalper', entry: scalper },
    { key: 'contrarian', entry: contrarian },
    { key: 'range', entry: range },
    { key: 'swing', entry: swing },
    { key: 'momentum-position', entry: momentumPosition },
  ];
  const standard = [
    { key: 'momentum', entry: momentum(3, '5', 0.5) },
    { key: 'dca', entry: dca },
    { key: 'scalper', entry: scalper },
    { key: 'contrarian', entry: contrarian },
    { key: 'range', entry: range },
    { key: 'swing', entry: swing },
    { key: 'momentum-position', entry: momentumPosition },
  ];
  const premium = [
    { key: 'momentum', entry: momentum(5, '10', 0.3) },
    { key: 'dca', entry: dca },
    { key: 'scalper', entry: scalper },
    { key: 'contrarian', entry: contrarian },
    { key: 'range', entry: range },
    { key: 'swing', entry: swing },
    { key: 'momentum-position', entry: momentumPosition },
  ];
  return { presets: { economy, standard, premium } };
}

// ---------------------------------------------------------------------------
// seedPresetCatalog / loadPresets
// ---------------------------------------------------------------------------

describe('seedPresetCatalog / loadPresets', () => {
  it('seeds and returns typed data for all 3 styles', async () => {
    const { seedPresetCatalog: seed, loadPresets: load } = await freshPresets();
    seed(catalogPayload());
    const presets = load();

    expect(presets.size).toBe(3);
    expect(presets.has('economy')).toBe(true);
    expect(presets.has('standard')).toBe(true);
    expect(presets.has('premium')).toBe(true);

    for (const style of ['economy', 'standard', 'premium'] as const) {
      const entries = presets.get(style);
      expect(entries, `missing ${style}`).toBeDefined();
      const keys = Object.keys(entries!);
      expect(keys.length).toBeGreaterThanOrEqual(7);
      expect(keys).toContain('momentum');
      expect(keys).toContain('dca');
      expect(keys).toContain('scalper');
    }
  });

  it('returns the same cached instance on subsequent calls', async () => {
    const { seedPresetCatalog: seed, loadPresets: load } = await freshPresets();
    seed(catalogPayload());
    const first = load();
    const second = load();
    expect(first).toBe(second); // same Map reference
  });

  it('throws when the catalog has not been seeded', async () => {
    const { loadPresets: load } = await freshPresets();
    expect(() => load()).toThrow(/not seeded/);
  });

  it('throws on a malformed catalog payload', async () => {
    const { seedPresetCatalog: seed } = await freshPresets();
    expect(() => seed({ presets: { economy: [{ key: 'x', entry: { bogus: true } }] } })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getPreset
// ---------------------------------------------------------------------------

describe('getPreset', () => {
  it('returns the economy momentum preset', async () => {
    const { seedPresetCatalog: seed, getPreset: get } = await freshPresets();
    seed(catalogPayload());
    const preset = get('momentum', 'economy');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Momentum — Day');
    expect(preset!.strategy.params['stopLossPct']).toBe(2);
    expect(preset!.strategy.params['positionSize']).toBe('2');
  });

  it('returns the premium momentum preset with different values', async () => {
    const { seedPresetCatalog: seed, getPreset: get } = await freshPresets();
    seed(catalogPayload());
    const preset = get('momentum', 'premium');
    expect(preset).toBeDefined();
    expect(preset!.strategy.params['stopLossPct']).toBe(5);
    expect(preset!.strategy.params['positionSize']).toBe('10');
  });

  it('returns undefined for a nonexistent strategy', async () => {
    const { seedPresetCatalog: seed, getPreset: get } = await freshPresets();
    seed(catalogPayload());
    const preset = get('nonexistent', 'economy');
    expect(preset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPresets
// ---------------------------------------------------------------------------

describe('listPresets', () => {
  it('returns expected presets for standard style', async () => {
    const { seedPresetCatalog: seed, listPresets: list } = await freshPresets();
    seed(catalogPayload());
    const entries = list('standard');

    expect(entries.length).toBeGreaterThanOrEqual(7);
    const keys = entries.map((e) => e.key).sort();
    // At minimum, the 7 core presets must be present
    expect(keys).toEqual(expect.arrayContaining([
      'contrarian',
      'dca',
      'momentum',
      'momentum-position',
      'range',
      'scalper',
      'swing',
    ]));

    // Each entry has the key plus PresetEntry fields
    for (const entry of entries) {
      expect(entry.key).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.strategy.type).toBeTruthy();
    }
  });

  it('returns economy presets with lower confidence thresholds', async () => {
    const { seedPresetCatalog: seed, listPresets: list } = await freshPresets();
    seed(catalogPayload());
    const economy = list('economy');
    const standard = list('standard');

    const ecoMomentum = economy.find((e) => e.key === 'momentum')!;
    const stdMomentum = standard.find((e) => e.key === 'momentum')!;

    const ecoConfidence = ecoMomentum.strategy.params['indicators'] as Record<string, unknown>;
    const ecoMin =
      (ecoConfidence['confidence'] as Record<string, unknown>)?.['minConfidence'];

    const stdConfidence = stdMomentum.strategy.params['indicators'] as Record<string, unknown>;
    const stdMin =
      (stdConfidence['confidence'] as Record<string, unknown>)?.['minConfidence'];

    // Economy should have higher minimum confidence (more conservative)
    expect(ecoMin).toBeGreaterThan(stdMin as number);
  });
});

// ---------------------------------------------------------------------------
// agentStyleToPresetStyle
// ---------------------------------------------------------------------------

describe('agentStyleToPresetStyle', () => {
  it("maps 'careful' to 'economy'", () => {
    expect(agentStyleToPresetStyle('careful')).toBe('economy');
  });

  it("maps 'balanced' to 'standard'", () => {
    expect(agentStyleToPresetStyle('balanced')).toBe('standard');
  });

  it("maps 'bold' to 'premium'", () => {
    expect(agentStyleToPresetStyle('bold')).toBe('premium');
  });

  it("defaults unknown styles to 'standard'", () => {
    expect(agentStyleToPresetStyle('reckless')).toBe('standard');
    expect(agentStyleToPresetStyle('')).toBe('standard');
    expect(agentStyleToPresetStyle('unknown')).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// applyPresetToAgent
// ---------------------------------------------------------------------------

describe('applyPresetToAgent', () => {
  function makeMomentumPreset(overrides?: Partial<PresetEntry>): PresetEntry {
    return {
      name: 'Test Momentum',
      description: 'Test momentum preset',
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          candleInterval: '1H',
          candleLimit: 24,
          stopLossPct: 5,
          takeProfitPct: 10,
          signalBias: 'trend-following',
          positionSize: '3',
          positionSizeMode: 'percent_equity',
          indicators: {
            rsi: { enabled: true, period: 14 },
            macd: { enabled: false },
          },
          scanIntervalMs: 30000,
        },
      },
      risk: {
        maxPositionSizePct: 15,
      },
      execution: {
        mode: 'paper',
      },
      ...overrides,
    };
  }

  it('produces correct split with technical, risk, and execution sections', () => {
    const preset = makeMomentumPreset();
    const result = applyPresetToAgent('test-momentum', preset, 'standard', 'llm');

    // Technical
    expect(result.technical.indicators).toEqual({
      rsi: { enabled: true, period: 14 },
      macd: { enabled: false },
    });
    expect(result.technical.candles).toEqual({ interval: '1h', limit: 24 });
    expect(result.technical.signalBias).toBe('trend-following');
    expect(result.technical.scanIntervalMs).toBe(30000);

    // Risk
    expect(result.risk.stopLossPct).toBe(5);
    expect(result.risk.maxPositionSizePct).toBe(15);

    // Execution — maps to unified agent config field names
    expect(result.execution.fixedPositionSize).toBe('3');
    expect(result.execution.positionSizeMode).toBe('percent_equity');
  });

  it('uses defaults when preset fields are missing', () => {
    const preset: PresetEntry = {
      name: 'Minimal',
      description: 'Minimal preset',
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {},
      },
    };
    const result = applyPresetToAgent('minimal', preset, 'standard', 'hybrid');

    expect(result.technical.indicators).toEqual({});
    expect(result.technical.candles).toEqual({ interval: '15m', limit: 48 });
    expect(result.technical.signalBias).toBe('trend-following');
    expect(result.risk.stopLossPct).toBeUndefined();
    expect(result.risk.maxPositionSizePct).toBeUndefined();
    expect(result.execution.fixedPositionSize).toBeUndefined();
    expect(result.execution.positionSizeMode).toBeUndefined();
  });

  it('omits risk fields when risk block is absent', () => {
    const preset = makeMomentumPreset({ risk: undefined });
    const result = applyPresetToAgent('test-momentum', preset, 'standard', 'llm');

    expect(result.risk.maxPositionSizePct).toBeUndefined();
    expect(result.risk.stopLossPct).toBe(5); // from strategy.params
  });

  it('handles non-numeric stopLossPct gracefully', () => {
    const preset = makeMomentumPreset({
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: { stopLossPct: '5%' }, // string, not number
      },
    });
    const result = applyPresetToAgent('test-momentum', preset, 'standard', 'llm');
    // stopLossPct is only included when it's a number
    expect(result.risk.stopLossPct).toBeUndefined();
  });

  it('rejects DCA preset for agent application', () => {
    const dcaPreset: PresetEntry = {
      name: 'DCA',
      description: 'Dollar-cost averaging',
      strategy: {
        type: 'dca',
        decisionMode: 'mechanical',
        params: { intervalMs: 86_400_000, amountPerBuy: '100' },
      },
    };
    expect(() => applyPresetToAgent('dca', dcaPreset, 'standard', 'llm')).toThrow(/dca.*not supported/i);
  });

  it('accepts all supported agent technical strategy types', () => {
    for (const type of AGENT_TECHNICAL_STRATEGY_TYPES) {
      const preset: PresetEntry = {
        name: `Test ${type}`,
        description: `Test preset for ${type}`,
        strategy: {
          type,
          decisionMode: 'mechanical',
          params: { candleInterval: '1H', candleLimit: 24, positionSize: '5' },
        },
      };
      const result = applyPresetToAgent(type, preset, 'standard', 'llm');
      expect(result.execution.fixedPositionSize).toBe('5');
    }
  });

  it('populates presetKey and presetBehaviorVersion in the mapping', () => {
    const preset = makeMomentumPreset();
    const result = applyPresetToAgent('momentum', preset, 'standard', 'llm');

    expect(result.presetKey).toBe('momentum');
    expect(result.presetBehaviorVersion).toBeDefined();
    expect(result.presetBehaviorVersion).toHaveLength(12);
    expect(/^[0-9a-f]{12}$/.test(result.presetBehaviorVersion)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computePresetBehaviorVersion
// ---------------------------------------------------------------------------

describe('computePresetBehaviorVersion', () => {
  const BASE_STRATEGY = {
    type: 'momentum' as const,
    decisionMode: 'mechanical' as const,
    params: {
      candleInterval: '1H',
      candleLimit: 24,
      stopLossPct: 5,
      takeProfitPct: 10,
      signalBias: 'trend-following',
      positionSize: '3',
      positionSizeMode: 'percent_equity',
      indicators: {
        rsi: { enabled: true, period: 14 },
        macd: { enabled: false },
      },
    },
  };

  function basePreset(overrides?: Partial<PresetEntry>): PresetEntry {
    return {
      name: 'Base Preset',
      description: 'Base preset for hash testing',
      strategy: { ...BASE_STRATEGY, params: { ...BASE_STRATEGY.params } },
      risk: { maxPositionSizePct: 15 },
      execution: { mode: 'paper' as const },
      ...overrides,
    };
  }

  it('produces same hash for identical behavior fields', () => {
    const a = basePreset();
    const b = basePreset();
    expect(computePresetBehaviorVersion(a)).toBe(computePresetBehaviorVersion(b));
  });

  it('produces different hash for different indicator params', () => {
    const a = basePreset();
    const b = basePreset({
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          ...BASE_STRATEGY.params,
          indicators: {
            rsi: { enabled: true, period: 21 },
            macd: { enabled: false },
          },
        },
      },
    });
    expect(computePresetBehaviorVersion(a)).not.toBe(computePresetBehaviorVersion(b));
  });

  it('produces different hash for different candle interval', () => {
    const a = basePreset();
    const b = basePreset({
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          ...BASE_STRATEGY.params,
          candleInterval: '4H',
        },
      },
    });
    expect(computePresetBehaviorVersion(a)).not.toBe(computePresetBehaviorVersion(b));
  });

  it('produces different hash for different signal bias', () => {
    const a = basePreset();
    const b = basePreset({
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {
          ...BASE_STRATEGY.params,
          signalBias: 'contrarian',
        },
      },
    });
    expect(computePresetBehaviorVersion(a)).not.toBe(computePresetBehaviorVersion(b));
  });

  it('produces different hash for different risk config', () => {
    const a = basePreset();
    const b = basePreset({
      risk: { maxPositionSizePct: 50 },
    });
    expect(computePresetBehaviorVersion(a)).not.toBe(computePresetBehaviorVersion(b));
  });

  it('display name change does NOT affect hash', () => {
    const a = basePreset({ name: 'Alpha Preset' });
    const b = basePreset({ name: 'Beta Preset' });
    expect(computePresetBehaviorVersion(a)).toBe(computePresetBehaviorVersion(b));
  });

  it('description change does NOT affect hash', () => {
    const a = basePreset({ description: 'Foo' });
    const b = basePreset({ description: 'Bar' });
    expect(computePresetBehaviorVersion(a)).toBe(computePresetBehaviorVersion(b));
  });

  it('hash is a 12-character hex string', () => {
    const preset = basePreset();
    const hash = computePresetBehaviorVersion(preset);
    expect(hash).toHaveLength(12);
    expect(/^[0-9a-f]{12}$/.test(hash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractBehaviorFields
// ---------------------------------------------------------------------------

describe('extractBehaviorFields', () => {
  it('extracts strategyType, decisionMode, params, risk, execution', () => {
    const preset: PresetEntry = {
      name: 'Test',
      description: 'Test description',
      strategy: {
        type: 'swing',
        decisionMode: 'hybrid',
        params: { candleInterval: '4H', signalBias: 'contrarian' },
      },
      risk: { maxPositionSizePct: 10 },
      execution: { mode: 'shadow' },
    };

    const fields = extractBehaviorFields(preset);
    expect(fields.strategyType).toBe('swing');
    expect(fields.decisionMode).toBe('hybrid');
    expect(fields.params).toEqual({ candleInterval: '4H', signalBias: 'contrarian' });
    expect(fields.risk).toEqual({ maxPositionSizePct: 10 });
    expect(fields.execution).toEqual({ mode: 'shadow' });
  });

  it('excludes display name and description', () => {
    const preset: PresetEntry = {
      name: 'Visible Name',
      description: 'Visible Description',
      strategy: { type: 'momentum', decisionMode: 'mechanical', params: {} },
    };

    const fields = extractBehaviorFields(preset);
    expect(fields).not.toHaveProperty('name');
    expect(fields).not.toHaveProperty('description');
  });

  it('sets risk and execution to null when absent', () => {
    const preset: PresetEntry = {
      name: 'No Risk/Exec',
      description: 'Minimal',
      strategy: { type: 'momentum', decisionMode: 'mechanical', params: {} },
    };

    const fields = extractBehaviorFields(preset);
    expect(fields.risk).toBeNull();
    expect(fields.execution).toBeNull();
  });
});
