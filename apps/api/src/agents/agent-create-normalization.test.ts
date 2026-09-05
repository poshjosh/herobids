/**
 * Tests for resolveUnifiedConfig — the shared normalization function used by
 * both the form route and the chat route to build unifiedConfig from creation
 * inputs.
 *
 * Focus: the step-9 guard that rejects scanner-gated agents without technical
 * config, and the happy path where a strategy preset fills the technical config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock resolveAgentStrategyPreset so we control whether a preset is resolved.
vi.mock('./strategy-preset-resolver.js', () => ({
  resolveAgentStrategyPreset: vi.fn(),
}));

// Mock plan-guards to avoid DB dependencies.
vi.mock('../plan-guards.js', () => ({
  resolvePlanLimitEntitlements: vi.fn().mockReturnValue({ maxBots: 5 }),
}));

// Mock agent-config-helpers to avoid DB dependencies.
vi.mock('../routes/agent-config-helpers.js', () => ({
  resolveNotificationPolicy: vi.fn().mockReturnValue(null),
}));

import { resolveAgentStrategyPreset } from './strategy-preset-resolver.js';
import { resolveUnifiedConfig, deriveToolPolicyFromSkills } from './agent-create-normalization.js';
import type { Database } from '@herobids/db';

const resolvePresetMock = vi.mocked(resolveAgentStrategyPreset);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock DB — only needs to support connection lookups in step 7. */
function mockDb(): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  } as unknown as Database;
}

/**
 * Mock DB whose connection lookup (step 7) returns a single active connection
 * with the given provider — used to exercise the filters-population/merge path.
 */
function mockDbWithProvider(provider: string): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ provider }]),
        }),
      }),
    }),
  } as unknown as Database;
}

/** A valid technical config from the momentum preset (real shape from YAML). */
const VALID_TECHNICAL: Record<string, unknown> = {
  filters: { venue: 'hyperliquid', venueType: 'orderbook' },
  regime: { benchmarkSymbol: 'BTC' },
  indicators: {
    trend: { enabled: true, emaFast: 9, emaSlow: 21 },
    momentum: { enabled: true, rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70 },
    volume: { enabled: true, volumeSmaPeriod: 20 },
    supportResistance: { enabled: false },
    choch: { enabled: false },
    confidenceWeights: { trend: 0.4, momentum: 0.3, volume: 0.2, supportResistance: 0.05, choch: 0.05 },
  },
  candles: { interval: '15m', limit: 100 },
  signalBias: 'trend-following',
  scanIntervalMs: 30000,
  scanBatchSize: 20,
  autonomousExit: true,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolveUnifiedConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Step-9 guard: reject scanner-gated without technical ────────────────

  it('throws when hybridMode is scanner_gated but no technical config is present', async () => {
    // No strategy preset → no technical from preset
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    await expect(
      resolveUnifiedConfig({
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        // NO strategyPreset
        // NO technical
        db,
      }),
    ).rejects.toThrow(/Cannot create a scanner-gated agent without a technical configuration/);
  });

  it('throws when hybridMode is scanner_gated and preset resolution returns null', async () => {
    // Strategy preset is provided but preset loader fails
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    await expect(
      resolveUnifiedConfig({
        strategyPreset: 'momentum',
        style: 'balanced',
        capabilityMode: 'hybrid',
        hybridMode: 'scanner_gated',
        // NO explicit technical
        db,
      }),
    ).rejects.toThrow(/Cannot create a scanner-gated agent without a technical configuration/);
  });

  // ── Happy path: preset fills technical ──────────────────────────────────

  it('produces unifiedConfig.technical when strategy preset is resolved', async () => {
    resolvePresetMock.mockReturnValue({
      unifiedConfigPatch: { technical: { ...VALID_TECHNICAL } },
      riskOverrides: {},
    });

    const db = mockDb();

    const result = await resolveUnifiedConfig({
      strategyPreset: 'momentum',
      style: 'balanced',
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['technical']).toBeDefined();
    expect(result!['capabilityMode']).toBe('hybrid');
    expect(result!['hybridMode']).toBe('scanner_gated');

    // Verify technical has the expected shape (was parsed through TechnicalConfigSchema)
    const tech = result!['technical'] as Record<string, unknown>;
    expect(tech.filters).toBeDefined();
    expect(tech.indicators).toBeDefined();
    expect(tech.signalBias).toBe('trend-following');
    expect(tech.scanIntervalMs).toBe(30000);
    expect(tech.autonomousExit).toBe(true);
  });

  // ── Mixed mode: no technical required ───────────────────────────────────

  it('does NOT throw for hybridMode=mixed without technical (lenient)', async () => {
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'mixed',
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['capabilityMode']).toBe('hybrid');
    expect(result!['hybridMode']).toBe('mixed');
    // No technical key — worker handles this gracefully
    expect(result!['technical']).toBeUndefined();
  });

  // ── Explicit technical wins over preset ─────────────────────────────────

  it('uses explicit technical config when provided, even with scanner-gated', async () => {
    // Even if preset resolution fails, explicit technical satisfies the guard
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: { ...VALID_TECHNICAL },
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['technical']).toBeDefined();
    expect(result!['hybridMode']).toBe('scanner_gated');
  });

  // ── Regression (bug 2026-09-04/004): connection enrichment must MERGE ───
  // Populating filters from the selected connection must set venue/venueType
  // (connection-authoritative) WITHOUT discarding client-supplied filter fields
  // such as symbols and minVolume24hUsd.

  it('merges connection venue/venueType into explicit filters without dropping client fields', async () => {
    resolvePresetMock.mockReturnValue(null);

    // Connection resolves to hyperliquid — venue/venueType come from here.
    const db = mockDbWithProvider('hyperliquid');

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      connectionIds: ['conn-1'],
      technical: {
        ...VALID_TECHNICAL,
        filters: {
          // Deliberately WITHOUT venue/venueType — client owns the rest.
          symbols: ['BTC', 'ETH'],
          excludeSymbols: ['DOGE'],
          minVolume24hUsd: 1_000_000,
        },
      },
      db,
    });

    const tech = result!['technical'] as Record<string, unknown>;
    const filters = tech['filters'] as Record<string, unknown>;

    // Connection-authoritative fields.
    expect(filters['venue']).toBe('hyperliquid');
    expect(filters['venueType']).toBe('orderbook');

    // Client-owned fields survive the merge (the regression).
    expect(filters['symbols']).toEqual(['BTC', 'ETH']);
    expect(filters['excludeSymbols']).toEqual(['DOGE']);
    expect(filters['minVolume24hUsd']).toBe(1_000_000);
  });

  it('connection venue/venueType overrides any client-supplied venue values', async () => {
    resolvePresetMock.mockReturnValue(null);

    // Client claims jupiter/swap, but the resolved connection is hyperliquid.
    const db = mockDbWithProvider('hyperliquid');

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      connectionIds: ['conn-1'],
      technical: {
        ...VALID_TECHNICAL,
        filters: {
          venue: 'jupiter',
          venueType: 'swap',
          symbols: ['BTC'],
        },
      },
      db,
    });

    const tech = result!['technical'] as Record<string, unknown>;
    const filters = tech['filters'] as Record<string, unknown>;

    // Connection wins for venue/venueType.
    expect(filters['venue']).toBe('hyperliquid');
    expect(filters['venueType']).toBe('orderbook');
    // Client-owned field still preserved.
    expect(filters['symbols']).toEqual(['BTC']);
  });

  // ── Intelligence mode: no technical required ────────────────────────────

  it('does NOT throw for intelligence mode without technical', async () => {
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const result = await resolveUnifiedConfig({
      capabilityMode: 'intelligence',
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['capabilityMode']).toBe('intelligence');
    expect(result!['technical']).toBeUndefined();
  });

  // ── Step-10 guard: scanner_gated orderbook requires regime ──────────────

  it('injects default regime when scanner_gated orderbook technical has no regime', async () => {
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const technicalNoRegime: Record<string, unknown> = {
      ...VALID_TECHNICAL,
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      regime: undefined,
    };
    delete technicalNoRegime['regime'];

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: technicalNoRegime,
      db,
    });

    // Step 9b injects default regime for orderbook agents
    const tech = result!['technical'] as Record<string, unknown>;
    expect(tech['regime']).toEqual({ benchmarkSymbol: 'BTC' });
  });

  it('does NOT throw when scanner_gated orderbook technical has regime', async () => {
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: { ...VALID_TECHNICAL, regime: { benchmarkSymbol: 'BTC' } },
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['technical']).toBeDefined();
    expect(result!['hybridMode']).toBe('scanner_gated');
  });

  it('does NOT throw when scanner_gated swap technical has no regime', async () => {
    resolvePresetMock.mockReturnValue(null);

    const db = mockDb();

    const swapTechnicalNoRegime: Record<string, unknown> = {
      ...VALID_TECHNICAL,
      filters: { venue: 'jupiter', venueType: 'swap' },
    };
    delete swapTechnicalNoRegime['regime'];

    const result = await resolveUnifiedConfig({
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      technical: swapTechnicalNoRegime,
      db,
    });

    expect(result).not.toBeNull();
    expect(result!['technical']).toBeDefined();
    expect(result!['hybridMode']).toBe('scanner_gated');
  });
});


// ── deriveToolPolicyFromSkills — manage_agent_skills grant ───────────────────

describe('deriveToolPolicyFromSkills — manage_agent_skills', () => {
  it('always adds manage_agent_skills grant when no existing policy', () => {
    const result = deriveToolPolicyFromSkills([]);

    expect(result).not.toBeNull();
    expect(result!['manage_agent_skills']).toEqual({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: true,
      limits: { maxPerMinute: 10, maxConcurrent: 1, timeoutMs: 30_000 },
    });
  });

  it('adds manage_agent_skills even without bot-management skill', () => {
    const result = deriveToolPolicyFromSkills(['web-access', 'trading']);

    expect(result).not.toBeNull();
    expect(result!['manage_agent_skills']).toBeDefined();
    expect((result!['manage_agent_skills'] as Record<string, unknown>)['enabled']).toBe(true);
  });

  it('does not overwrite existing manage_agent_skills in the policy', () => {
    const existingPolicy = {
      manage_agent_skills: {
        capability: 'manage_agent_skills',
        tier: 'brokered',
        enabled: false,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 15_000 },
      },
    };

    const result = deriveToolPolicyFromSkills([], existingPolicy);

    // Should preserve the existing (disabled) entry, not overwrite
    expect(result!['manage_agent_skills']).toEqual({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: false,
      limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 15_000 },
    });
  });

  it('returns both manage_bot and manage_agent_skills when bot-management skill is present', () => {
    const result = deriveToolPolicyFromSkills(['bot-management']);

    expect(result).not.toBeNull();
    expect(result!['manage_bot']).toBeDefined();
    expect((result!['manage_bot'] as Record<string, unknown>)['enabled']).toBe(true);
    expect(result!['manage_agent_skills']).toBeDefined();
    expect((result!['manage_agent_skills'] as Record<string, unknown>)['enabled']).toBe(true);
  });

  it('returns non-null when existingPolicy is explicitly null', () => {
    const result = deriveToolPolicyFromSkills([], null);

    // manage_agent_skills is always added, so result is never null
    expect(result).not.toBeNull();
    expect(result!['manage_agent_skills']).toBeDefined();
    expect((result!['manage_agent_skills'] as Record<string, unknown>)['enabled']).toBe(true);
  });

  it('preserves other existing policy entries alongside manage_agent_skills', () => {
    const existingPolicy = {
      submit_decision: {
        capability: 'submit_decision',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 20 },
      },
    };

    const result = deriveToolPolicyFromSkills([], existingPolicy);

    expect(result!['submit_decision']).toEqual(existingPolicy['submit_decision']);
    expect(result!['manage_agent_skills']).toBeDefined();
  });
});
