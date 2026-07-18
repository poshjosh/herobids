import { describe, it, expect, vi } from 'vitest';
import { PlatformAssessor } from './platform-assessor.js';
import type { PlatformAssessorConfig, PlatformAssessorDeps, EvidencePackage } from './platform-assessor.js';
import type { MarketAssessmentIdentity } from '@herobids/domain';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeIdentity(overrides?: Partial<Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>>): MarketAssessmentIdentity {
  return {
    instrumentKind: 'perp',
    venueFamily: 'hyperliquid-orderbook',
    styleTier: 'standard',
    symbol: 'BTC',
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PlatformAssessorConfig>): PlatformAssessorConfig {
  return {
    enabled: true,
    maxConcurrentAssessments: 1,
    maxLlmCallsPerCycle: 5,
    cacheFreshnessMs: 60_000,
    ...overrides,
  };
}

// ── In-memory DB mock ──────────────────────────────────────────────────────

function makeDbMock() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    select: vi.fn(),
  };
}

// ── Redis mock ─────────────────────────────────────────────────────────────

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    del: vi.fn(async () => 1),
  };
}

// ── Deps factory ───────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<PlatformAssessorDeps>): PlatformAssessorDeps {
  return {
    db: makeDbMock() as unknown as PlatformAssessorDeps['db'],
    redis: makeRedisMock() as unknown as PlatformAssessorDeps['redis'],
    getRegimeSnapshot: vi.fn(async () => ({
      pass: true,
      reasons: ['test'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 50000,
        emaFast: 49800,
        emaSlow: 49000,
        emaTrend: 48500,
        emaAlignment: 'bullish' as const,
        adxValue: 28,
        choppy: false,
        vwap: 49700,
        priceAboveVwap: true,
        marketStructure: 'higherHighs' as const,
      },
    })),
    getPresetKeys: vi.fn(async (_styleTier: string) => ['momentum_v1', 'mean_reversion_v1', 'trend_following_v1']),
    callLlm: vi.fn(async (_prompt: string) => '{}'),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PlatformAssessor', () => {
  describe('construction', () => {
    it('applies defaults when minimal config is provided', () => {
      const assessor = new PlatformAssessor({}, makeDeps());
      expect(assessor).toBeDefined();
    });

    it('respects explicit config values', () => {
      const assessor = new PlatformAssessor(
        { maxLlmCallsPerCycle: 10, cacheFreshnessMs: 120_000 },
        makeDeps(),
      );
      expect(assessor).toBeDefined();
    });
  });

  describe('assessIdentity', () => {
    it('returns an ok result with an artifact for a valid identity', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.id).toBeDefined();
        expect(result.data.status).toBe('active');
        expect(result.data.venueFamily).toBe(identity.venueFamily);
        expect(result.data.styleTier).toBe(identity.styleTier);
        expect(result.data.presetRankings).toHaveLength(3);
        expect(result.data.recommendedPreset).toBe('momentum_v1');
      }
    });

    it('returns an err result when disabled', async () => {
      const assessor = new PlatformAssessor({ enabled: false }, makeDeps());
      const identity = makeIdentity();

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.disabled');
      }
    });

    it('returns an err result when evidence collection throws', async () => {
      const deps = makeDeps();
      deps.getRegimeSnapshot = vi.fn(async () => { throw new Error('regime unavailable'); });
      deps.getPresetKeys = vi.fn(async () => { throw new Error('preset catalog unavailable'); });
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const result = await assessor.assessIdentity(makeIdentity());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.failed');
      }
    });

    it('handles swap/dex identity', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc123',
      };

      const result = await assessor.assessIdentity(identity);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.venueFamily).toBe('jupiter');
        expect(result.data.styleTier).toBe('economy');
      }
    });
  });

  describe('collectEvidence', () => {
    it('returns an EvidencePackage with identity', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const evidence = await assessor.collectEvidence(identity);

      expect(evidence.identity).toEqual(identity);
      expect(evidence.collectedAt).toBeDefined();
      expect(evidence.regime).toBeDefined();
      expect(evidence.breadth).toBeDefined();
      expect(evidence.volatility).toBeDefined();
      expect(evidence.liquidityQuality).toBeDefined();
      expect(evidence.scanHealth).toBeDefined();
    });

    it('uses placeholder regime when getRegimeSnapshot fails', async () => {
      const deps = makeDeps();
      deps.getRegimeSnapshot = vi.fn(async () => { throw new Error('upstream failure'); });
      const assessor = new PlatformAssessor(makeConfig(), deps);

      const evidence = await assessor.collectEvidence(makeIdentity());
      expect(evidence.regime.reasons.some((r) => r.includes('placeholder'))).toBe(true);
    });
  });

  describe('generateScorecards', () => {
    it('returns one entry per preset key', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const evidence = await assessor.collectEvidence(identity);
      const presetKeys = ['p1', 'p2', 'p3'];

      const scorecards = await assessor.generateScorecards(identity, evidence, presetKeys);
      expect(scorecards).toHaveLength(3);
      expect(scorecards[0]!.presetKey).toBe('p1');
      expect(scorecards.every((s) => s.scanHealth === 'stale')).toBe(true);
    });

    it('returns empty array for empty preset keys', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const evidence = await assessor.collectEvidence(identity);

      const scorecards = await assessor.generateScorecards(identity, evidence, []);
      expect(scorecards).toHaveLength(0);
    });
  });

  describe('rankPresets', () => {
    it('returns a basic artifact with all required fields', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const evidence = await assessor.collectEvidence(identity);
      const scorecards = await assessor.generateScorecards(identity, evidence, ['momentum_v1']);

      const artifact = await assessor.rankPresets(identity, evidence, scorecards);
      expect(artifact.id).toBeDefined();
      expect(artifact.venueFamily).toBe(identity.venueFamily);
      expect(artifact.styleTier).toBe(identity.styleTier);
      expect(artifact.status).toBe('active');
      expect(artifact.presetRankings).toHaveLength(1);
      expect(artifact.recommendedPreset).toBe('momentum_v1');
    });

    it('handles empty scorecards gracefully', async () => {
      const assessor = new PlatformAssessor(makeConfig(), makeDeps());
      const identity = makeIdentity();
      const evidence = await assessor.collectEvidence(identity);

      const artifact = await assessor.rankPresets(identity, evidence, []);
      expect(artifact.presetRankings).toHaveLength(0);
      expect(artifact.recommendedPreset).toBeNull();
    });
  });
});
