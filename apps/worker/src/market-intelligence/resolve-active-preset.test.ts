import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, type Result, type ActivePresetState } from '@herobids/domain';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockResolveAuthoritativeBinding = vi.fn();
const mockGetPreset = vi.fn();
const mockApplyPresetToAgent = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('./binding-resolver.js', () => ({
  resolveAuthoritativeBinding: mockResolveAuthoritativeBinding,
}));

vi.mock('@herobids/domain/config/presets-loader', () => ({
  getPreset: mockGetPreset,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn: mockLoggerWarn }),
}));

// isStyleKey and applyPresetToAgent are re-exported from @herobids/domain;
// we mock applyPresetToAgent but let isStyleKey pass through as the real function.
vi.mock('@herobids/domain', async () => {
  const actual = await vi.importActual<typeof import('@herobids/domain')>('@herobids/domain');
  return {
    ...actual,
    applyPresetToAgent: mockApplyPresetToAgent,
  };
});

// ── Dynamic import of SUT ───────────────────────────────────────────────────

let resolveActivePresetState: typeof import('./resolve-active-preset.js').resolveActivePresetState;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-import to pick up fresh mocks each test
  const mod = await import('./resolve-active-preset.js');
  resolveActivePresetState = mod.resolveActivePresetState;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides?: Partial<{ id: string; unifiedConfig: unknown }>) {
  return {
    id: 'agent-1',
    unifiedConfig: {},
    ...overrides,
  };
}

const mockDb = {} as unknown as import('@herobids/db').Database;

function setupBinding(
  presetKey: string,
  styleTier: 'economy' | 'standard' | 'premium',
  behaviorVersion: string,
) {
  mockResolveAuthoritativeBinding.mockResolvedValue({
    activePresetKey: presetKey,
    styleTier,
    behaviorVersion,
    appliedPresetVersion: '1.0.0',
  });

  const mockPreset = { strategy: { type: presetKey, decisionMode: 'mechanical', params: {} } };
  mockGetPreset.mockReturnValue(mockPreset);

  mockApplyPresetToAgent.mockReturnValue({
    presetKey,
    presetStyle: styleTier,
    presetBehaviorVersion: behaviorVersion,
    technical: {
      indicators: { rsi: {}, macd: {} },
      candles: { interval: '15m', limit: 48 },
      signalBias: 'neutral',
      scanIntervalMs: 30_000,
    },
    risk: {},
    execution: {},
  });
}

function setupMetadataPreset(
  presetKey: string,
  styleTier: string,
  overrides?: { presetBehaviorVersion?: string; allowedStyleTier?: string },
) {
  mockResolveAuthoritativeBinding.mockResolvedValue(null);

  const mockPreset = { strategy: { type: presetKey, decisionMode: 'mechanical', params: {} } };
  mockGetPreset.mockReturnValue(mockPreset);

  mockApplyPresetToAgent.mockReturnValue({
    presetKey,
    presetStyle: styleTier,
    presetBehaviorVersion: 'mapping-version',
    technical: {
      indicators: { rsi: {}, macd: {} },
      candles: { interval: '15m', limit: 48 },
      signalBias: 'neutral',
      scanIntervalMs: 30_000,
    },
    risk: {},
    execution: {},
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('resolveActivePresetState', () => {
  // ── A.1: Authoritative binding wins ──────────────────────────────────

  it('prefers authoritative binding over metadata.strategyPreset', async () => {
    setupBinding('scalper', 'premium', 'binding-version');

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'momentum',
          strategyPresetStyle: 'standard',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.presetKey).toBe('scalper');
    expect(result.data.styleTier).toBe('premium');
    expect(result.data.behaviorVersion).toBe('binding-version');
    // Should not have fallen through to metadata
    expect(mockGetPreset).toHaveBeenCalledWith('scalper', 'premium');
  });

  // ── A.2: Metadata fallback when no binding ───────────────────────────

  it('falls back to metadata.strategyPreset when no binding exists', async () => {
    setupMetadataPreset('swing', 'economy');

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'swing',
          strategyPresetStyle: 'economy',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.presetKey).toBe('swing');
    expect(result.data.styleTier).toBe('economy');
    expect(mockGetPreset).toHaveBeenCalledWith('swing', 'economy');
  });

  // ── A.3: presetBehaviorVersion from metadata preferred ───────────────

  it('prefers metadata.presetBehaviorVersion over mapping.presetBehaviorVersion', async () => {
    // mapping's version is 'mapping-version', metadata provides 'meta-version'
    setupMetadataPreset('momentum', 'standard', { presetBehaviorVersion: 'meta-version' });

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'momentum',
          strategyPresetStyle: 'standard',
          presetBehaviorVersion: 'meta-version',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.behaviorVersion).toBe('meta-version');
  });

  it('uses mapping.presetBehaviorVersion when metadata does not provide one', async () => {
    setupMetadataPreset('momentum', 'standard');

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'momentum',
          strategyPresetStyle: 'standard',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.behaviorVersion).toBe('mapping-version');
  });

  // ── A.4: Absent metadata → loud fallback ─────────────────────────────

  it('falls through to loud momentum fallback when unifiedConfig has no metadata', async () => {
    mockResolveAuthoritativeBinding.mockResolvedValue(null);

    const agent = makeAgent({ unifiedConfig: {} });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.presetKey).toBe('momentum');
    expect(result.data.behaviorVersion).toContain('fallback');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
      expect.stringContaining('safety fallback'),
    );
  });

  // ── A.5: Unknown preset key in metadata → loud fallback ─────────────

  it('falls through to loud momentum fallback when metadata preset key is unknown', async () => {
    mockResolveAuthoritativeBinding.mockResolvedValue(null);
    // getPreset returns undefined → unknown preset
    mockGetPreset.mockReturnValue(undefined);

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'nonexistent_preset',
          strategyPresetStyle: 'standard',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.presetKey).toBe('momentum');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        strategyPreset: 'nonexistent_preset',
      }),
      expect.stringContaining('Metadata preset key not found'),
    );
  });

  // ── A.6: Style tier fallback chain ──────────────────────────────────

  it('uses allowedPresets.styleTier when strategyPresetStyle is invalid', async () => {
    mockResolveAuthoritativeBinding.mockResolvedValue(null);

    const mockPreset = { strategy: { type: 'momentum', decisionMode: 'mechanical', params: {} } };
    mockGetPreset.mockReturnValue(mockPreset);
    mockApplyPresetToAgent.mockReturnValue({
      presetKey: 'momentum',
      presetStyle: 'premium',
      presetBehaviorVersion: 'v1',
      technical: { indicators: {}, candles: { interval: '15m', limit: 48 }, signalBias: 'neutral' },
      risk: {},
      execution: {},
    });

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'momentum',
          strategyPresetStyle: 'not-a-valid-style',
        },
        allowedPresets: {
          styleTier: 'premium',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.styleTier).toBe('premium');
    expect(mockGetPreset).toHaveBeenCalledWith('momentum', 'premium');
  });

  it('defaults styleTier to standard when all sources are invalid', async () => {
    mockResolveAuthoritativeBinding.mockResolvedValue(null);
    mockGetPreset.mockReturnValue(undefined);

    const agent = makeAgent({
      unifiedConfig: {
        metadata: {
          strategyPreset: 'momentum',
          strategyPresetStyle: 'not-a-valid-style',
        },
      },
    });

    const result = await resolveActivePresetState(mockDb, agent);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');

    expect(result.data.styleTier).toBe('standard');
  });
});
