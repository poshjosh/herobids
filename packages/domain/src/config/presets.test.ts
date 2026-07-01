import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadPresets,
  getPreset,
  listPresets,
  agentStyleToPresetStyle,
  applyPresetToAgent,
  type PresetEntry,
} from './presets.js';

// The presets module uses a module-level cache. Clear it between tests so
// each test gets a fresh load (important when we mock readFileSync).
// We do this by re-importing the module after vi.resetModules().

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Helper: re-import presets module with a clean cache
// ---------------------------------------------------------------------------

async function freshPresets() {
  return await import('./presets.js');
}

// ---------------------------------------------------------------------------
// loadPresets
// ---------------------------------------------------------------------------

describe('loadPresets', () => {
  it('loads YAML files, validates, and returns typed data for all 3 styles', async () => {
    const { loadPresets: load } = await freshPresets();
    const presets = load();

    expect(presets.size).toBe(3);
    expect(presets.has('economy')).toBe(true);
    expect(presets.has('standard')).toBe(true);
    expect(presets.has('premium')).toBe(true);

    // Every style should have at least the 7 core strategies
    for (const style of ['economy', 'standard', 'premium'] as const) {
      const entries = presets.get(style);
      expect(entries, `missing ${style}`).toBeDefined();
      const keys = Object.keys(entries!);
      expect(keys.length).toBeGreaterThanOrEqual(7);
      // Verify known strategy keys exist
      expect(keys).toContain('momentum');
      expect(keys).toContain('dca');
      expect(keys).toContain('scalper');
    }
  });

  it('returns the same cached instance on subsequent calls', async () => {
    const { loadPresets: load } = await freshPresets();
    const first = load();
    const second = load();
    expect(first).toBe(second); // same Map reference
  });

  it('validates preset entries have required fields', async () => {
    const { loadPresets: load } = await freshPresets();
    const presets = load();
    const economy = presets.get('economy')!;
    const momentum = economy['momentum']!;

    expect(momentum.name).toBeTruthy();
    expect(momentum.description).toBeTruthy();
    expect(momentum.strategy.type).toBe('momentum');
    // decisionMode defaults to 'mechanical' when absent from YAML
    expect(momentum.strategy.decisionMode).toBe('mechanical');
    expect(momentum.strategy.params).toBeDefined();
    expect(typeof momentum.strategy.params['candleInterval']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// getPreset
// ---------------------------------------------------------------------------

describe('getPreset', () => {
  it('returns the economy momentum preset', async () => {
    const { getPreset: get } = await freshPresets();
    const preset = get('momentum', 'economy');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('Momentum — Day');
    expect(preset!.strategy.params['stopLossPct']).toBe(2);
    expect(preset!.strategy.params['positionSize']).toBe('2');
  });

  it('returns the premium momentum preset with different values', async () => {
    const { getPreset: get } = await freshPresets();
    const preset = get('momentum', 'premium');
    expect(preset).toBeDefined();
    // Premium has wider stops, larger positions
    expect(preset!.strategy.params['stopLossPct']).toBe(5);
    expect(preset!.strategy.params['positionSize']).toBe('10');
  });

  it('returns undefined for a nonexistent strategy', async () => {
    const { getPreset: get } = await freshPresets();
    const preset = get('nonexistent', 'economy');
    expect(preset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPresets
// ---------------------------------------------------------------------------

describe('listPresets', () => {
  it('returns expected presets for standard style', async () => {
    const { listPresets: list } = await freshPresets();
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
    const { listPresets: list } = await freshPresets();
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
  it("maps 'careful' to 'economy'", async () => {
    const { agentStyleToPresetStyle: map } = await freshPresets();
    expect(map('careful')).toBe('economy');
  });

  it("maps 'balanced' to 'standard'", async () => {
    const { agentStyleToPresetStyle: map } = await freshPresets();
    expect(map('balanced')).toBe('standard');
  });

  it("maps 'bold' to 'premium'", async () => {
    const { agentStyleToPresetStyle: map } = await freshPresets();
    expect(map('bold')).toBe('premium');
  });

  it("defaults unknown styles to 'standard'", async () => {
    const { agentStyleToPresetStyle: map } = await freshPresets();
    expect(map('reckless')).toBe('standard');
    expect(map('')).toBe('standard');
    expect(map('unknown')).toBe('standard');
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

  it('produces correct split with technical, risk, and execution sections', async () => {
    const { applyPresetToAgent: apply } = await freshPresets();
    const preset = makeMomentumPreset();
    const result = apply(preset, 'llm');

    // Technical
    expect(result.technical.indicators).toEqual({
      rsi: { enabled: true, period: 14 },
      macd: { enabled: false },
    });
    expect(result.technical.candles).toEqual({ interval: '1H', limit: 24 });
    expect(result.technical.signalBias).toBe('trend-following');
    expect(result.technical.scanIntervalMs).toBe(30000);

    // Risk
    expect(result.risk.stopLossPct).toBe(5);
    expect(result.risk.maxPositionSizePct).toBe(15);

    // Execution
    expect(result.execution.positionSize).toBe('3');
    expect(result.execution.positionSizeMode).toBe('percent_equity');
  });

  it('uses defaults when preset fields are missing', async () => {
    const { applyPresetToAgent: apply } = await freshPresets();
    const preset: PresetEntry = {
      name: 'Minimal',
      description: 'Minimal preset',
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: {},
      },
    };
    const result = apply(preset, 'hybrid');

    expect(result.technical.indicators).toEqual({});
    expect(result.technical.candles).toEqual({ interval: '15m', limit: 48 });
    expect(result.technical.signalBias).toBe('trend-following');
    expect(result.risk.stopLossPct).toBeUndefined();
    expect(result.risk.maxPositionSizePct).toBeUndefined();
    expect(result.execution.positionSize).toBeUndefined();
    expect(result.execution.positionSizeMode).toBeUndefined();
  });

  it('omits risk fields when risk block is absent', async () => {
    const { applyPresetToAgent: apply } = await freshPresets();
    const preset = makeMomentumPreset({ risk: undefined });
    const result = apply(preset, 'llm');

    expect(result.risk.maxPositionSizePct).toBeUndefined();
    expect(result.risk.stopLossPct).toBe(5); // from strategy.params
  });

  it('handles non-numeric stopLossPct gracefully', async () => {
    const { applyPresetToAgent: apply } = await freshPresets();
    const preset = makeMomentumPreset({
      strategy: {
        type: 'momentum',
        decisionMode: 'mechanical',
        params: { stopLossPct: '5%' }, // string, not number
      },
    });
    const result = apply(preset, 'llm');
    // stopLossPct is only included when it's a number
    expect(result.risk.stopLossPct).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fail-fast on invalid YAML
// ---------------------------------------------------------------------------

describe('fail-fast validation', () => {
  it('throws when YAML is missing the presets key', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    // Build a temp directory structure that mimics the project layout.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'herobids-preset-test-'));
    const presetsDir = join(tmpRoot, 'config', 'strategy-presets');
    mkdirSync(presetsDir, { recursive: true });

    // Invalid YAML for economy (missing the `presets` key)
    writeFileSync(join(presetsDir, 'economy.yaml'), 'not_presets:\n  foo: bar\n', 'utf-8');

    // Valid files for the other two styles — copy from the real config
    const realPresetsDir = join(process.cwd(), 'config', 'strategy-presets');
    cpSync(join(realPresetsDir, 'standard.yaml'), join(presetsDir, 'standard.yaml'));
    cpSync(join(realPresetsDir, 'premium.yaml'), join(presetsDir, 'premium.yaml'));

    const prevEnv = process.env['HEROBIDS_CONFIG_DIR'];
    process.env['HEROBIDS_CONFIG_DIR'] = tmpRoot;

    try {
      const { loadPresets: load } = await freshPresets();
      expect(() => load()).toThrow();
    } finally {
      process.env['HEROBIDS_CONFIG_DIR'] = prevEnv;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
