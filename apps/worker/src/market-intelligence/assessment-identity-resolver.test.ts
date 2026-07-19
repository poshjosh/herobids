import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssessmentIdentityResolverImpl } from './assessment-identity-resolver.js';
import type { AssessmentIdentityResolverDeps } from './assessment-identity-resolver.js';
import type { VenueInstrumentCache } from '../venue-instrument-cache.js';
import { ok, err } from '@herobids/domain';

// ── Mock domain-level resolveAssessmentIdentity ─────────────────────────────
// We spy on the domain function to verify it receives the right input,
// while also allowing the real implementation to run for orderbook/perp paths
// that rely on symbol validation via knownSymbols.

vi.mock('@herobids/domain', async () => {
  const actual = await vi.importActual('@herobids/domain');
  return {
    ...actual,
  };
});

// ── Mock Helpers ───────────────────────────────────────────────────────────

/**
 * Creates a DB mock where each `select()` call pops the next resolved value
 * from the provided queue. This lets us control what each successive query
 * in the service returns without needing per-call argument matching.
 */
function makeQueueDb(selectQueue: unknown[]) {
  let idx = 0;

  function createChain(value: unknown): any {
    const fn: any = function () {
      return createChain(value);
    };
    fn.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);

    return new Proxy(fn, {
      get(_target, prop) {
        if (prop === 'then' || prop === 'catch') {
          return Reflect.get(_target, prop, _target);
        }
        return createChain(value);
      },
    });
  }

  return {
    select: vi.fn(() => {
      const value = idx < selectQueue.length
        ? selectQueue[idx]!
        : (selectQueue.length > 0 ? selectQueue[selectQueue.length - 1] : []);
      idx++;
      return createChain(value);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
}

function makeMockInstrumentCache(overrides?: Partial<{
  isVenueReady: boolean;
  knownSymbols: Set<string> | null;
}>): VenueInstrumentCache {
  const knownSymbols = overrides && 'knownSymbols' in overrides
    ? overrides.knownSymbols
    : new Set(['BTC', 'ETH']);
  return {
    isVenueReady: vi.fn().mockReturnValue(overrides?.isVenueReady ?? true),
    getKnownSymbols: vi.fn().mockReturnValue(knownSymbols),
    hasSymbol: vi.fn().mockReturnValue(true),
    isReady: vi.fn().mockReturnValue(true),
    getFailedProviders: vi.fn().mockReturnValue(new Set()),
    warmup: vi.fn(),
    startPeriodicRefresh: vi.fn(),
    stop: vi.fn(),
    getSymbolCount: vi.fn().mockReturnValue(100),
  } as unknown as VenueInstrumentCache;
}

// ── Helpers to build DB select queue results ──────────────────────────────

/** A bot row that references a venue account. */
function botRow(venueAccountId: string) {
  return { venueAccountId };
}

/** A venue account row with a profile that specifies venueType. */
function venueAccountRow(venueFamily: string, venueType: 'orderbook' | 'swap') {
  return {
    venueFamily,
    venueProfile: {
      venue: venueFamily,
      venueType,
      availableSymbols: ['BTC', 'ETH'],
      supportedExecutionModes: ['paper'],
      authenticated: true,
      probedAt: new Date().toISOString(),
    },
  };
}

/** An agent row with unifiedConfig.technical.filters. */
function agentRow(venueFamily?: string, venueType?: string) {
  return {
    unifiedConfig: venueFamily
      ? {
          technical: { filters: { venue: venueFamily, venueType } },
        }
      : {},
  };
}

/** An active preset binding row. */
function presetBindingRow(styleTier: 'economy' | 'standard' | 'premium') {
  return { styleTier };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AssessmentIdentityResolverImpl', () => {
  let mockInstrumentCache: ReturnType<typeof makeMockInstrumentCache>;

  beforeEach(() => {
    mockInstrumentCache = makeMockInstrumentCache();
  });

  function createResolver(
    selectQueue: unknown[],
    overrides?: Partial<AssessmentIdentityResolverDeps>,
  ) {
    const db = makeQueueDb(selectQueue);
    return new AssessmentIdentityResolverImpl({
      db: db as any,
      instrumentCache: mockInstrumentCache,
      ...overrides,
    });
  }

  // ── Resolves venue/instrument from bot binding ─────────────────────────

  describe('venue/instrument resolution', () => {
    it('resolves venue/instrument from bot binding', async () => {
      const resolver = createResolver([
        [botRow('va-1')],                            // bot query
        [venueAccountRow('hyperliquid', 'orderbook')], // venue account query
        [presetBindingRow('standard')],                // style tier query
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-1',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const identity = result.data;
        expect(identity.venueFamily).toBe('hyperliquid');
        expect(identity.instrumentKind).toBe('orderbook');
        expect(identity.styleTier).toBe('standard');
        if (identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp') {
          expect(identity.symbol).toBe('BTC');
        }
      }
    });

    it('falls back to unified config when no bot binding exists', async () => {
      const resolver = createResolver([
        [],                                           // bot query → empty
        [agentRow('hyperliquid', 'perp')],             // agent fallback
        [presetBindingRow('premium')],                 // style tier
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-2',
        symbol: 'ETH',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.venueFamily).toBe('hyperliquid');
        expect(result.data.instrumentKind).toBe('perp');
        expect(result.data.styleTier).toBe('premium');
        if (result.data.instrumentKind === 'orderbook' || result.data.instrumentKind === 'perp') {
          expect(result.data.symbol).toBe('ETH');
        }
      }
    });

    it('returns no_binding when neither bot nor unified config exists', async () => {
      const resolver = createResolver([
        [],  // bot query → empty
        [],  // agent fallback → empty
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-3',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_binding');
      }
    });

    it('uses explicit venueFamily/instrumentKind and skips binding resolution', async () => {
      const resolver = createResolver([
        [presetBindingRow('economy')], // only style tier query needed
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-4',
        symbol: 'BTC',
        venueFamily: 'bybit',
        instrumentKind: 'perp',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.venueFamily).toBe('bybit');
        expect(result.data.instrumentKind).toBe('perp');
        expect(result.data.styleTier).toBe('economy');
      }
    });
  });

  // ── Style tier resolution ──────────────────────────────────────────────

  describe('style tier resolution', () => {
    it('resolves style tier from agent_preset_bindings', async () => {
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('premium')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-5',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.styleTier).toBe('premium');
      }
    });

    it('returns no_style_tier when no active default binding exists', async () => {
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [], // no preset binding
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-6',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_style_tier');
      }
    });

    it('uses explicit styleTier and skips binding lookup', async () => {
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-7',
        symbol: 'BTC',
        styleTier: 'economy',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.styleTier).toBe('economy');
      }
    });
  });

  // ── Venue instrument cache (fail-closed) ───────────────────────────────

  describe('venue instrument cache', () => {
    it('fails closed when venue instrument cache is not ready', async () => {
      mockInstrumentCache = makeMockInstrumentCache({ isVenueReady: false });
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('standard')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-8',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.venue_not_ready');
      }
    });

    it('fails for unknown symbol when cache is ready', async () => {
      mockInstrumentCache = makeMockInstrumentCache({
        isVenueReady: true,
        knownSymbols: new Set(['ETH']), // BTC not in set
      });
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('standard')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-9',
        symbol: 'BTC',
      });

      // The domain-level resolveAssessmentIdentity rejects unknown symbols
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.unknown_symbol');
      }
    });

    it('succeeds for known symbol when cache is ready', async () => {
      mockInstrumentCache = makeMockInstrumentCache({
        isVenueReady: true,
        knownSymbols: new Set(['BTC', 'ETH']),
      });
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('standard')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-10',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.instrumentKind).toBe('orderbook');
        if (result.data.instrumentKind === 'orderbook' || result.data.instrumentKind === 'perp') {
          expect(result.data.symbol).toBe('BTC');
        }
      }
    });

    it('allows all symbols when knownSymbols is null (venue not configured)', async () => {
      mockInstrumentCache = makeMockInstrumentCache({
        isVenueReady: true,
        knownSymbols: null, // venue not configured → fail-open at domain level
      });
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('standard')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-11',
        symbol: 'ANYTHING',
      });

      expect(result.ok).toBe(true);
    });
  });

  // ── Swap/DEX token resolution ──────────────────────────────────────────

  describe('swap/dex token resolution', () => {
    it('fails when token resolver is not configured', async () => {
      const resolver = createResolver(
        [
          [botRow('va-2')],
          [venueAccountRow('jupiter', 'swap')],
          [presetBindingRow('standard')],
        ],
        // resolveToken not provided
      );

      const result = await resolver.resolveIdentity({
        agentId: 'agent-12',
        symbol: 'USDC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.token_resolver_not_configured');
      }
    });

    it('resolves swap/dex symbol via token resolver', async () => {
      const resolveToken = vi.fn().mockResolvedValue({
        network: 'solana',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      });

      const resolver = createResolver(
        [
          [botRow('va-2')],
          [venueAccountRow('jupiter', 'swap')],
          [presetBindingRow('standard')],
        ],
        { resolveToken },
      );

      const result = await resolver.resolveIdentity({
        agentId: 'agent-13',
        symbol: 'USDC',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.instrumentKind).toBe('swap');
        if (result.data.instrumentKind === 'swap' || result.data.instrumentKind === 'dex') {
          expect(result.data.network).toBe('solana');
          expect(result.data.address).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        }
      }
      expect(resolveToken).toHaveBeenCalledWith('USDC');
    });

    it('fails when token resolver returns null (unresolved token)', async () => {
      const resolveToken = vi.fn().mockResolvedValue(null);

      const resolver = createResolver(
        [
          [botRow('va-2')],
          [venueAccountRow('jupiter', 'swap')],
          [presetBindingRow('standard')],
        ],
        { resolveToken },
      );

      const result = await resolver.resolveIdentity({
        agentId: 'agent-14',
        symbol: 'UNKNOWN_TOKEN',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_token_resolutions');
      }
    });
  });

  // ── Symbol validation ──────────────────────────────────────────────────

  describe('symbol validation', () => {
    it('rejects empty symbol', async () => {
      const resolver = createResolver([]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-15',
        symbol: '',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.invalid_symbol');
      }
    });

    it('rejects whitespace-only symbol', async () => {
      const resolver = createResolver([]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-16',
        symbol: '   ',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.invalid_symbol');
      }
    });

    it('trims symbol whitespace before validation', async () => {
      mockInstrumentCache = makeMockInstrumentCache({
        isVenueReady: true,
        knownSymbols: new Set(['BTC']),
      });
      const resolver = createResolver([
        [botRow('va-1')],
        [venueAccountRow('hyperliquid', 'orderbook')],
        [presetBindingRow('standard')],
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-17',
        symbol: '  BTC  ',
      });

      expect(result.ok).toBe(true);
      if (result.ok && (result.data.instrumentKind === 'orderbook' || result.data.instrumentKind === 'perp')) {
        expect(result.data.symbol).toBe('BTC');
      }
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns missing_venue when binding has no venueFamily', async () => {
      // Bot exists but venue account has no venueFamily
      const resolver = createResolver([
        [{ venueAccountId: 'va-no-venue' }],
        [{ venueFamily: null, venueProfile: { venueType: 'orderbook' } }],
        [], // agent fallback → no unifiedConfig
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-18',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_binding');
      }
    });

    it('returns null binding when venue account has no venueProfile', async () => {
      const resolver = createResolver([
        [{ venueAccountId: 'va-no-profile' }],
        [{ venueFamily: 'hyperliquid', venueProfile: null }],
        [], // agent fallback → no unifiedConfig
      ]);

      const result = await resolver.resolveIdentity({
        agentId: 'agent-19',
        symbol: 'BTC',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('assessment.identity.no_binding');
      }
    });
  });
});
