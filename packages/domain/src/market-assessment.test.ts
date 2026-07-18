import { describe, it, expect } from 'vitest';
import {
  computeUniverseScopeHash,
  createSegmentKey,
  segmentKeyFromTechnicalConfig,
  isArtifactFresh,
  isArtifactStale,
  canTriggerWake,
  canUseForTransition,
  getArtifactFreshnessStatus,
  isValidTransition,
  MarketAssessmentIdentitySchema,
  resolveAssessmentIdentity,
} from './market-assessment.js';
import type { MarketAssessmentArtifact, MarketAssessmentIdentity } from './market-assessment.js';
import type { TechnicalConfig } from './config/schema.js';

describe('computeUniverseScopeHash', () => {
  it('produces the same hash for identical inputs', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
      networks: ['ethereum', 'arbitrum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
      networks: ['arbitrum', 'ethereum'], // different order
    });
    expect(h1).toBe(h2); // normalized sorting ensures determinism
  });

  it('produces different hashes for different venue families', () => {
    const h1 = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    const h2 = computeUniverseScopeHash({ venueFamily: 'bybit-orderbook' });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different volume thresholds', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 1_000_000,
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 10_000_000,
    });
    expect(h1).not.toBe(h2);
  });

  it('produces different hashes for different symbol lists', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH', 'SOL'],
    });
    expect(h1).not.toBe(h2);
  });

  it('produces same hash regardless of symbol list order', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['SOL', 'ETH', 'BTC'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      symbols: ['BTC', 'ETH', 'SOL'],
    });
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different network lists', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum', 'polygon'],
    });
    expect(h1).not.toBe(h2);
  });

  it('produces same hash regardless of network list order', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['arbitrum', 'ethereum'],
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      networks: ['ethereum', 'arbitrum'],
    });
    expect(h1).toBe(h2);
  });

  it('excludes null/undefined optional fields from hash', () => {
    const h1 = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: undefined,
    });
    expect(h1).toBe(h2);
  });

  it('treats zero volume threshold same as unset', () => {
    const h1 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
    });
    const h2 = computeUniverseScopeHash({
      venueFamily: 'hyperliquid-orderbook',
      minVolume24hUsd: 0,
      minLiquidityUsd: 0,
    });
    expect(h1).toBe(h2);
  });

  it('returns a 16-character hex string', () => {
    const hash = computeUniverseScopeHash({ venueFamily: 'hyperliquid-orderbook' });
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('createSegmentKey', () => {
  it('creates a segment key with all three components', () => {
    const key = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'standard',
      networks: ['ethereum'],
    });
    expect(key.venueFamily).toBe('hyperliquid-orderbook');
    expect(key.styleTier).toBe('standard');
    expect(key.universeScopeHash).toHaveLength(16);
  });

  it('produces the same key for equivalent inputs', () => {
    const k1 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
      symbols: ['BTC', 'ETH'],
    });
    const k2 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
      symbols: ['ETH', 'BTC'],
    });
    expect(k1).toEqual(k2);
  });

  it('produces different keys for different style tiers', () => {
    const k1 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'economy',
    });
    const k2 = createSegmentKey({
      venueFamily: 'hyperliquid-orderbook',
      styleTier: 'premium',
    });
    expect(k1).not.toEqual(k2);
  });
});

describe('segmentKeyFromTechnicalConfig', () => {
  it('derives a correct segment key from a minimal technical config', () => {
    const config = {
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook' as const,
      },
    } as TechnicalConfig;
    const key = segmentKeyFromTechnicalConfig(config, 'standard');
    expect(key.venueFamily).toBe('hyperliquid-orderbook');
    expect(key.styleTier).toBe('standard');
    expect(key.universeScopeHash).toHaveLength(16);
  });

  it('includes all discovery filters in the hash', () => {
    const fullConfig = {
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook' as const,
        minVolume24hUsd: 5_000_000,
        minLiquidityUsd: 500_000,
        networks: ['ethereum', 'arbitrum'],
        symbols: ['BTC', 'ETH'],
        excludeSymbols: ['DOGE'],
      },
    } as TechnicalConfig;
    const key = segmentKeyFromTechnicalConfig(fullConfig, 'premium');
    expect(key.universeScopeHash).toHaveLength(16);

    const minimalKey = segmentKeyFromTechnicalConfig(
      { filters: { venue: 'hyperliquid', venueType: 'orderbook' } } as TechnicalConfig,
      'premium',
    );
    expect(key.universeScopeHash).not.toBe(minimalKey.universeScopeHash);
  });
});

// ── Freshness & Staleness Helpers ───────────────────────────────────────────

function makeTestArtifact(overrides?: Partial<MarketAssessmentArtifact>): MarketAssessmentArtifact {
  const now = new Date();
  const future = new Date(now.getTime() + 3_600_000); // +1 hour
  return {
    id: 'test-artifact-1',
    segmentKey: { venueFamily: 'hyperliquid-orderbook', styleTier: 'standard', universeScopeHash: 'abc123' },
    assessmentRunId: 'run-1',
    assessedAt: now.toISOString(),
    expiresAt: future.toISOString(),
    maxActorUseAge: future.toISOString(),
    maxWakeAge: future.toISOString(),
    assessmentVersion: 1,
    artifactVersion: 1,
    rankingPolicyVersion: 1,
    styleTier: 'standard',
    allowedPresets: ['momentum', 'range'],
    currentMarketSummary: 'test',
    regimeSummary: 'test',
    scanHealthSummary: 'test',
    presetRankings: [],
    recommendedPreset: null,
    relativeUplift: null,
    confidence: 0.5,
    urgency: 'low',
    reasoningSummary: 'test',
    evidenceRefs: [],
    status: 'active',
    venueFamily: 'hyperliquid-orderbook',
    universeScopeHash: 'abc123',
    ...overrides,
  };
}

describe('isArtifactFresh', () => {
  it('returns true for active artifact not yet expired', () => {
    const artifact = makeTestArtifact();
    expect(isArtifactFresh(artifact)).toBe(true);
  });

  it('returns false for an expired artifact', () => {
    const past = new Date(Date.now() - 3_600_000);
    const artifact = makeTestArtifact({ expiresAt: past.toISOString() });
    expect(isArtifactFresh(artifact)).toBe(false);
  });

  it('returns false for a superseded artifact even if not expired', () => {
    const artifact = makeTestArtifact({ status: 'superseded' });
    expect(isArtifactFresh(artifact)).toBe(false);
  });

  it('accepts an explicit now date', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const expiresAt = new Date('2026-07-18T13:00:00Z');
    const artifact = makeTestArtifact({ expiresAt: expiresAt.toISOString() });

    // Before expiry
    expect(isArtifactFresh(artifact, new Date('2026-07-18T12:30:00Z'))).toBe(true);
    // Exactly at expiry
    expect(isArtifactFresh(artifact, new Date('2026-07-18T13:00:00Z'))).toBe(false);
    // After expiry
    expect(isArtifactFresh(artifact, new Date('2026-07-18T13:01:00Z'))).toBe(false);
  });

  it('returns false for status=expired regardless of date', () => {
    const future = new Date(Date.now() + 86_400_000); // +1 day
    const artifact = makeTestArtifact({ status: 'expired', expiresAt: future.toISOString() });
    expect(isArtifactFresh(artifact)).toBe(false);
  });
});

describe('isArtifactStale', () => {
  it('returns false for a fresh artifact', () => {
    const artifact = makeTestArtifact();
    expect(isArtifactStale(artifact)).toBe(false);
  });

  it('returns true for an expired artifact', () => {
    const past = new Date(Date.now() - 3_600_000);
    const artifact = makeTestArtifact({ expiresAt: past.toISOString() });
    expect(isArtifactStale(artifact)).toBe(true);
  });

  it('returns true for a superseded artifact', () => {
    const artifact = makeTestArtifact({ status: 'superseded' });
    expect(isArtifactStale(artifact)).toBe(true);
  });
});

describe('canTriggerWake', () => {
  it('returns true when fresh and within maxWakeAge', () => {
    const artifact = makeTestArtifact();
    expect(canTriggerWake(artifact)).toBe(true);
  });

  it('returns false when expired', () => {
    const past = new Date(Date.now() - 7_200_000);
    const artifact = makeTestArtifact({ expiresAt: past.toISOString() });
    expect(canTriggerWake(artifact)).toBe(false);
  });

  it('returns false when past maxWakeAge but not yet expired', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const wakeDeadline = new Date('2026-07-18T12:30:00Z');
    const expiresAt = new Date('2026-07-18T14:00:00Z'); // expiry is later
    const artifact = makeTestArtifact({
      maxWakeAge: wakeDeadline.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    expect(canTriggerWake(artifact, new Date('2026-07-18T13:00:00Z'))).toBe(false);
  });

  it('returns false when superseded', () => {
    const artifact = makeTestArtifact({ status: 'superseded' });
    expect(canTriggerWake(artifact)).toBe(false);
  });

  it('returns false exactly at maxWakeAge deadline', () => {
    const deadline = new Date('2026-07-18T12:30:00Z');
    const artifact = makeTestArtifact({ maxWakeAge: deadline.toISOString() });
    expect(canTriggerWake(artifact, new Date('2026-07-18T12:30:00Z'))).toBe(false);
  });
});

describe('canUseForTransition', () => {
  it('returns true when fresh and within maxActorUseAge', () => {
    const artifact = makeTestArtifact();
    expect(canUseForTransition(artifact)).toBe(true);
  });

  it('returns false when expired', () => {
    const past = new Date(Date.now() - 7_200_000);
    const artifact = makeTestArtifact({ expiresAt: past.toISOString() });
    expect(canUseForTransition(artifact)).toBe(false);
  });

  it('returns false when past maxActorUseAge but not yet expired', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const useDeadline = new Date('2026-07-18T12:30:00Z');
    const expiresAt = new Date('2026-07-18T14:00:00Z');
    const artifact = makeTestArtifact({
      maxActorUseAge: useDeadline.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    expect(canUseForTransition(artifact, new Date('2026-07-18T13:00:00Z'))).toBe(false);
  });

  it('returns false when superseded', () => {
    const artifact = makeTestArtifact({ status: 'superseded' });
    expect(canUseForTransition(artifact)).toBe(false);
  });

  it('returns false exactly at maxActorUseAge deadline', () => {
    const deadline = new Date('2026-07-18T12:30:00Z');
    const artifact = makeTestArtifact({ maxActorUseAge: deadline.toISOString() });
    expect(canUseForTransition(artifact, new Date('2026-07-18T12:30:00Z'))).toBe(false);
  });
});

describe('getArtifactFreshnessStatus', () => {
  it('returns fresh for a fully fresh artifact', () => {
    const artifact = makeTestArtifact();
    expect(getArtifactFreshnessStatus(artifact)).toBe('fresh');
  });

  it('returns stale_superseded when status is superseded', () => {
    const artifact = makeTestArtifact({ status: 'superseded' });
    expect(getArtifactFreshnessStatus(artifact)).toBe('stale_superseded');
  });

  it('returns stale_expired when past expiresAt', () => {
    const past = new Date(Date.now() - 3_600_000);
    const artifact = makeTestArtifact({ expiresAt: past.toISOString() });
    expect(getArtifactFreshnessStatus(artifact)).toBe('stale_expired');
  });

  it('returns stale_for_wake when past maxWakeAge but still fresh overall', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    const wakeDeadline = new Date('2026-07-18T12:30:00Z');
    const expiresAt = new Date('2026-07-18T14:00:00Z');
    const maxActorUseAge = new Date('2026-07-18T13:00:00Z');
    const artifact = makeTestArtifact({
      maxWakeAge: wakeDeadline.toISOString(),
      maxActorUseAge: maxActorUseAge.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    // Now is past wake deadline but before maxActorUseAge and expiry
    expect(getArtifactFreshnessStatus(artifact, new Date('2026-07-18T12:45:00Z'))).toBe('stale_for_wake');
  });

  it('returns stale_for_transition when past maxActorUseAge but still wakeable', () => {
    const now = new Date('2026-07-18T12:00:00Z');
    // maxActorUseAge is stricter (earlier) than maxWakeAge in this scenario
    const maxActorUseAge = new Date('2026-07-18T12:30:00Z');
    const maxWakeAge = new Date('2026-07-18T13:00:00Z');
    const expiresAt = new Date('2026-07-18T14:00:00Z');
    const artifact = makeTestArtifact({
      maxWakeAge: maxWakeAge.toISOString(),
      maxActorUseAge: maxActorUseAge.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    // Now is past maxActorUseAge but still within maxWakeAge and expiry
    expect(getArtifactFreshnessStatus(artifact, new Date('2026-07-18T12:45:00Z'))).toBe('stale_for_transition');
  });

  it('superseded takes priority over expired in status check', () => {
    const past = new Date(Date.now() - 86_400_000);
    const artifact = makeTestArtifact({ status: 'superseded', expiresAt: past.toISOString() });
    expect(getArtifactFreshnessStatus(artifact)).toBe('stale_superseded');
  });

  it('returns fresh for artifact with future dates', () => {
    const farFuture = new Date('2027-01-01T00:00:00Z');
    const artifact = makeTestArtifact({
      expiresAt: farFuture.toISOString(),
      maxWakeAge: farFuture.toISOString(),
      maxActorUseAge: farFuture.toISOString(),
    });
    expect(getArtifactFreshnessStatus(artifact)).toBe('fresh');
  });
});

describe('isValidTransition', () => {
  // Platform transitions
  it('allows assessment_available → wake_emitted', () => {
    expect(isValidTransition('assessment_available', 'wake_emitted')).toBe(true);
  });
  it('allows assessment_available → wake_suppressed', () => {
    expect(isValidTransition('assessment_available', 'wake_suppressed')).toBe(true);
  });
  it('rejects wake_emitted → assessment_available (terminal)', () => {
    expect(isValidTransition('wake_emitted', 'assessment_available')).toBe(false);
  });
  it('rejects wake_suppressed → assessment_available (terminal)', () => {
    expect(isValidTransition('wake_suppressed', 'assessment_available')).toBe(false);
  });

  // Actor transitions
  it('allows actor_reviewed → transition_recommended', () => {
    expect(isValidTransition('actor_reviewed', 'transition_recommended')).toBe(true);
  });
  it('allows actor_reviewed → transition_deferred', () => {
    expect(isValidTransition('actor_reviewed', 'transition_deferred')).toBe(true);
  });
  it('allows actor_reviewed → transition_rejected', () => {
    expect(isValidTransition('actor_reviewed', 'transition_rejected')).toBe(true);
  });
  it('allows transition_recommended → transition_applied', () => {
    expect(isValidTransition('transition_recommended', 'transition_applied')).toBe(true);
  });
  it('rejects transition_applied → anything (terminal)', () => {
    expect(isValidTransition('transition_applied', 'actor_reviewed')).toBe(false);
  });

  // Cross-boundary
  it('rejects platform → actor transition', () => {
    expect(isValidTransition('assessment_available', 'actor_reviewed')).toBe(false);
  });
  it('rejects actor → platform transition', () => {
    expect(isValidTransition('actor_reviewed', 'wake_emitted')).toBe(false);
  });
});

// ── Canonical Assessment Identity ───────────────────────────────────────────

describe('MarketAssessmentIdentitySchema', () => {
  it('rejects mixed shapes (e.g. orderbook with network+address)', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      network: 'ethereum',
      address: '0x123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects mixed shapes (e.g. swap with symbol)', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'swap',
      venueFamily: 'jupiter',
      styleTier: 'standard',
      symbol: 'SOL',
    });
    expect(result.success).toBe(false);
  });

  it('parses valid orderbook identity', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'orderbook',
      venueFamily: 'hyperliquid',
      styleTier: 'standard',
      symbol: 'BTC',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        instrumentKind: 'orderbook',
        venueFamily: 'hyperliquid',
        styleTier: 'standard',
        symbol: 'BTC',
      });
    }
  });

  it('parses valid perp identity', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'perp',
      venueFamily: 'hyperliquid',
      styleTier: 'premium',
      symbol: 'ETH-USD',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        instrumentKind: 'perp',
        symbol: 'ETH-USD',
      });
    }
  });

  it('parses valid swap identity', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'swap',
      venueFamily: 'jupiter',
      styleTier: 'economy',
      network: 'solana',
      address: 'So11111111111111111111111111111111111111112',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        network: 'solana',
        address: 'So11111111111111111111111111111111111111112',
      });
    }
  });

  it('parses valid dex identity', () => {
    const result = MarketAssessmentIdentitySchema.safeParse({
      instrumentKind: 'dex',
      venueFamily: 'uniswap',
      styleTier: 'standard',
      network: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        instrumentKind: 'dex',
        network: 'ethereum',
      });
    }
  });
});

// ── Identity Resolution ─────────────────────────────────────────────────────

describe('resolveAssessmentIdentity', () => {
  const baseParams = {
    venueFamily: 'hyperliquid',
    styleTier: 'standard' as const,
    symbol: 'BTC',
  };

  describe('orderbook / perp path', () => {
    it('orderbook symbol in known set → ok', () => {
      const result = resolveAssessmentIdentity({
        ...baseParams,
        instrumentKind: 'orderbook',
        knownSymbols: new Set(['BTC', 'ETH', 'SOL']),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const identity = result.data as Extract<MarketAssessmentIdentity, { instrumentKind: 'orderbook' | 'perp' }>;
        expect(identity.symbol).toBe('BTC');
        expect(identity.instrumentKind).toBe('orderbook');
      }
    });

    it('orderbook symbol NOT in known set → unknown_symbol', () => {
      const result = resolveAssessmentIdentity({
        ...baseParams,
        instrumentKind: 'orderbook',
        symbol: 'DOGE',
        knownSymbols: new Set(['BTC', 'ETH']),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.unknown_symbol');
      }
    });

    it('empty symbol → invalid_symbol', () => {
      const result = resolveAssessmentIdentity({
        ...baseParams,
        instrumentKind: 'orderbook',
        symbol: '   ',
        knownSymbols: new Set(['BTC']),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.invalid_symbol');
      }
    });
  });

  describe('swap / dex path', () => {
    const swapBase = {
      venueFamily: 'jupiter',
      styleTier: 'economy' as const,
    };

    it('swap exact match → ok with network+address', () => {
      const result = resolveAssessmentIdentity({
        ...swapBase,
        instrumentKind: 'swap',
        symbol: 'USDC',
        tokenResolutions: new Map([
          ['USDC', { network: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
        ]),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const identity = result.data as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>;
        expect(identity.network).toBe('solana');
        expect(identity.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      }
    });

    it('swap multiple case-insensitive matches → ambiguous_symbol', () => {
      const result = resolveAssessmentIdentity({
        ...swapBase,
        instrumentKind: 'swap',
        symbol: 'usdc',
        tokenResolutions: new Map([
          ['USDC', { network: 'ethereum', address: '0xA0b8...' }],
          ['Usdc', { network: 'solana', address: 'EPjFW...' }],
        ]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.ambiguous_symbol');
      }
    });

    it('swap zero matches → unknown_symbol', () => {
      const result = resolveAssessmentIdentity({
        ...swapBase,
        instrumentKind: 'swap',
        symbol: 'NOSUCHTOKEN',
        tokenResolutions: new Map([
          ['USDC', { network: 'solana', address: 'EPjFW...' }],
          ['SOL', { network: 'solana', address: 'So111...' }],
        ]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.unknown_symbol');
      }
    });

    it('swap empty tokenResolutions → no_token_resolutions', () => {
      const result = resolveAssessmentIdentity({
        ...swapBase,
        instrumentKind: 'swap',
        symbol: 'USDC',
        tokenResolutions: new Map(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_token_resolutions');
      }
    });

    it('swap single case-insensitive match → resolves', () => {
      const result = resolveAssessmentIdentity({
        ...swapBase,
        instrumentKind: 'swap',
        symbol: 'usdc',
        tokenResolutions: new Map([
          ['USDC', { network: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
          ['SOL', { network: 'solana', address: 'So11111111111111111111111111111111111111112' }],
        ]),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const identity = result.data as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>;
        expect(identity.network).toBe('solana');
        expect(identity.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      }
    });
  });
});
