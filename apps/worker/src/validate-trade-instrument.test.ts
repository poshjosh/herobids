import { describe, it, expect, vi } from 'vitest';
import { validateTradeInstrument } from './validate-trade-instrument.js';
import { parseSwapInstrumentId } from './swap-instrument-id.js';
import type { VenueInstrumentCache } from './venue-instrument-cache.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCache(ready = true, symbols: Record<string, Set<string>> = {}): VenueInstrumentCache {
  return {
    isReady: () => ready,
    hasSymbol: (venue: string, symbol: string) => symbols[venue]?.has(symbol) ?? true,
    isVenueReady: (venue: string) => ready && venue in symbols,
    getKnownSymbols: (venue: string) => symbols[venue] ?? null,
    getFailedProviders: () => new Set(),
  } as VenueInstrumentCache;
}

// ── Sample real addresses ──────────────────────────────────────────────────

const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';

const baseCanonicalTokens = {
  base: {
    USDC: { address: BASE_USDC, name: 'USD Coin', aliases: [] as string[] },
    WETH: { address: BASE_WETH, name: 'Wrapped Ether', aliases: ['ETH'] as string[] },
  },
};

const solanaCanonicalTokens = {
  solana: {
    USDC: { address: SOL_USDC, name: 'USD Coin', aliases: [] as string[] },
    BONK: { address: BONK_MINT, name: 'Bonk', aliases: [] as string[] },
  },
};

// ── Orderbook venues ────────────────────────────────────────────────────────

describe('Orderbook venues', () => {
  it('rejects unknown instrument when cache is ready', () => {
    const cache = makeCache(true, { hyperliquid: new Set(['BTC-PERP', 'ETH-PERP']) });
    const result = validateTradeInstrument('hyperliquid', 'DOGE-PERP', cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a recognized instrument');
  });

  it('accepts known instrument when cache is ready', () => {
    const cache = makeCache(true, { hyperliquid: new Set(['BTC-PERP', 'ETH-PERP']) });
    const result = validateTradeInstrument('hyperliquid', 'BTC-PERP', cache);
    expect(result.valid).toBe(true);
  });

  it('accepts when cache is not ready (fail-open)', () => {
    const cache = makeCache(false);
    const result = validateTradeInstrument('hyperliquid', 'ANYTHING', cache);
    expect(result.valid).toBe(true);
  });
});

// ── Jupiter: exact (both addresses) ─────────────────────────────────────────

describe('Jupiter exact pair', () => {
  it('accepts when both mints are in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set([BONK_MINT, SOL_USDC]),
    });
    const instrumentId = `BONK:${BONK_MINT}/USDC:${SOL_USDC}`;
    const result = validateTradeInstrument('jupiter', instrumentId, cache);
    expect(result.valid).toBe(true);
  });

  it('rejects when base mint is not in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set([SOL_USDC]), // BONK missing
    });
    const instrumentId = `BONK:${BONK_MINT}/USDC:${SOL_USDC}`;
    const result = validateTradeInstrument('jupiter', instrumentId, cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Base token address');
    expect(result.reason).toContain('not found');
  });

  it('rejects when quote mint is not in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set([BONK_MINT]), // USDC missing
    });
    const instrumentId = `BONK:${BONK_MINT}/USDC:${SOL_USDC}`;
    const result = validateTradeInstrument('jupiter', instrumentId, cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Quote token address');
    expect(result.reason).toContain('not found');
  });

  it('accepts when cache is not ready (fail-open)', () => {
    const cache = makeCache(false);
    const instrumentId = `BONK:${BONK_MINT}/USDC:${SOL_USDC}`;
    const result = validateTradeInstrument('jupiter', instrumentId, cache);
    expect(result.valid).toBe(true);
  });
});

// ── Jupiter: base-qualified (base address only) ─────────────────────────────

describe('Jupiter base-qualified', () => {
  it('accepts when base mint and quote symbol are in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set([BONK_MINT, 'USDC']),
    });
    const result = validateTradeInstrument('jupiter', `BONK:${BONK_MINT}/USDC`, cache);
    expect(result.valid).toBe(true);
  });

  it('rejects when base mint is not in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set(['USDC']),
    });
    const result = validateTradeInstrument('jupiter', `BONK:${BONK_MINT}/USDC`, cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Base token address');
  });

  it('rejects when quote symbol is not in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set([BONK_MINT]), // USDC not known
    });
    const result = validateTradeInstrument('jupiter', `BONK:${BONK_MINT}/USDC`, cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a recognized instrument');
  });
});

// ── Jupiter: legacy plain pair ──────────────────────────────────────────────

describe('Jupiter legacy', () => {
  it('accepts when display symbol is in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set(['BONK/USDC']),
    });
    const result = validateTradeInstrument('jupiter', 'BONK/USDC', cache);
    expect(result.valid).toBe(true);
  });

  it('rejects when display symbol is not in cache', () => {
    const cache = makeCache(true, {
      jupiter: new Set(['SOL/USDC']),
    });
    const result = validateTradeInstrument('jupiter', 'BONK/USDC', cache);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a recognized instrument');
  });
});

// ── 1inch: exact (both addresses) ───────────────────────────────────────────

describe('1inch exact pair', () => {
  it('accepts when both addresses are valid EVM and quote matches canonical USDC', () => {
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
      canonicalTokens: baseCanonicalTokens,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when base address is not valid EVM', () => {
    const instrumentId = 'WETH:not-an-address/USDC:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
      canonicalTokens: baseCanonicalTokens,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid EVM address');
  });

  it('rejects when quote address is not valid EVM', () => {
    const instrumentId = `WETH:${BASE_WETH}/USDC:not-an-address`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
      canonicalTokens: baseCanonicalTokens,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid EVM address');
  });

  it('rejects when network cannot be determined', () => {
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      // no oneInchConfig at all — network unresolvable
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Cannot determine 1inch network');
  });

  it('rejects when network is not base', () => {
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 1 }, // Ethereum, not Base
      canonicalTokens: baseCanonicalTokens,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("only 'base' is supported");
  });

  it('rejects when quote address does not match canonical USDC', () => {
    const wrongUsdc = '0x0000000000000000000000000000000000000001';
    const instrumentId = `WETH:${BASE_WETH}/USDC:${wrongUsdc}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
      canonicalTokens: baseCanonicalTokens,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match canonical USDC address');
  });

  it('rejects when canonicalTokens is undefined', () => {
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
      // canonicalTokens intentionally omitted
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No canonical USDC address configured');
  });

  it('resolves network from binding-profile chainId override (exact pair)', () => {
    // Binding specifies an unsupported chainId (Ethereum mainnet) that
    // overrides the operator default (Base). The instrument should be
    // rejected because only Base is supported for scanner trading.
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      oneInchConfig: { chainId: 8453 },            // operator default → Base
      canonicalTokens: baseCanonicalTokens,
      bindingProfile: { chainId: 1 },               // binding override → Ethereum
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("only 'base' is supported");
  });

  it('resolves network from binding-profile network field override (exact pair)', () => {
    // Binding explicitly sets network to 'base', overriding a missing
    // operator config. Validation should proceed.
    const instrumentId = `WETH:${BASE_WETH}/USDC:${BASE_USDC}`;
    const result = validateTradeInstrument('1inch', instrumentId, makeCache(false), {
      // no oneInchConfig — network must come from bindingProfile
      canonicalTokens: baseCanonicalTokens,
      bindingProfile: { network: 'base' },
    });
    expect(result.valid).toBe(true);
  });
});

// ── 1inch: base-qualified ───────────────────────────────────────────────────

describe('1inch base-qualified', () => {
  it('accepts when base address is valid EVM and network is base', () => {
    const result = validateTradeInstrument('1inch', `WETH:${BASE_WETH}/USDC`, makeCache(false), {
      oneInchConfig: { chainId: 8453 },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when base address is not valid EVM', () => {
    const result = validateTradeInstrument('1inch', 'WETH:garbage/USDC', makeCache(false), {
      oneInchConfig: { chainId: 8453 },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid EVM address');
  });

  it('rejects when network is not base', () => {
    const result = validateTradeInstrument('1inch', `WETH:${BASE_WETH}/USDC`, makeCache(false), {
      oneInchConfig: { chainId: 1 },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("only 'base' is supported");
  });
});

// ── 1inch: legacy plain pair (always passes, structural only) ───────────────

describe('1inch legacy', () => {
  it('accepts plain BASE/QUOTE (fail-open structural path)', () => {
    const result = validateTradeInstrument('1inch', 'WETH/USDC', makeCache(false));
    expect(result.valid).toBe(true);
  });

  it('accepts plain BASE/QUOTE even with garbage cache state', () => {
    // 1inch has no curated cache requirement for legacy paths
    const result = validateTradeInstrument('1inch', 'ANYTHING/ANYTHING', makeCache(true, {}));
    expect(result.valid).toBe(true);
  });
});

// ── Malformed instrument IDs ────────────────────────────────────────────────

describe('Malformed instrument IDs', () => {
  it('rejects swap instrument with no slash', () => {
    const result = validateTradeInstrument('jupiter', 'BTC', makeCache(true));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid swap instrument ID');
  });

  it('rejects swap instrument with too many slashes', () => {
    const result = validateTradeInstrument('jupiter', 'A/B/C', makeCache(true));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not a valid swap instrument ID');
  });
});

// ── Schema regression guard — exact DEX instrument IDs ──────────────────────
// Phase 5 guard: verifies that the exact BASE:ADDR/QUOTE:ADDR ID passes
// through every Zod schema boundary and clears both parseSwapInstrumentId()
// and validateTradeInstrument() for Jupiter (Solana) and 1inch (Base).

import { DecisionSubmitPayloadSchema } from '@herobids/domain';
import { SubmitDecisionParamsSchema } from './tools/trading.js';

const SOL_BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_WETH_ADDR = '0x4200000000000000000000000000000000000006';
const BASE_USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const SOL_EXACT_ID = `BONK:${SOL_BONK_MINT}/USDC:${SOL_USDC_MINT}`;
const EVM_EXACT_ID = `WETH:${BASE_WETH_ADDR}/USDC:${BASE_USDC_ADDR}`;

describe('Schema regression guard — exact DEX instrument IDs', () => {
  // ── DecisionSubmitPayloadSchema ─────────────────────────────────────────

  describe('DecisionSubmitPayloadSchema', () => {
    it('accepts Solana exact BASE:ADDR/QUOTE:ADDR ID', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({
        decisionId: 'dec-001',
        instrumentId: SOL_EXACT_ID,
        intent: 'go_long',
        targetSize: '1.5',
        rationaleSummary: 'Momentum signal',
      });
      expect(result.success).toBe(true);
    });

    it('accepts EVM exact BASE:ADDR/QUOTE:ADDR ID', () => {
      const result = DecisionSubmitPayloadSchema.safeParse({
        decisionId: 'dec-002',
        instrumentId: EVM_EXACT_ID,
        intent: 'go_long',
        targetSize: '0.01',
        rationaleSummary: 'Base DEX signal',
      });
      expect(result.success).toBe(true);
    });
  });

  // ── SubmitDecisionParamsSchema ──────────────────────────────────────────

  describe('SubmitDecisionParamsSchema', () => {
    const validParams = {
      instrumentId: '',
      intent: 'go_long' as const,
      targetSize: '1.5',
      rationaleSummary: 'Test signal',
    };

    it('accepts Solana exact BASE:ADDR/QUOTE:ADDR ID', () => {
      const result = SubmitDecisionParamsSchema.safeParse({
        ...validParams,
        instrumentId: SOL_EXACT_ID,
      });
      expect(result.success).toBe(true);
    });

    it('accepts EVM exact BASE:ADDR/QUOTE:ADDR ID', () => {
      const result = SubmitDecisionParamsSchema.safeParse({
        ...validParams,
        instrumentId: EVM_EXACT_ID,
      });
      expect(result.success).toBe(true);
    });
  });

  // ── parseSwapInstrumentId ───────────────────────────────────────────────

  describe('parseSwapInstrumentId', () => {
    it('parses Solana exact ID with both addresses', () => {
      const parsed = parseSwapInstrumentId(SOL_EXACT_ID);
      expect(parsed.displaySymbol).toBe('BONK/USDC');
      expect(parsed.baseAddress).toBe(SOL_BONK_MINT);
      expect(parsed.quoteAddress).toBe(SOL_USDC_MINT);
      expect(parsed.isExact).toBe(true);
    });

    it('parses EVM exact ID with both addresses', () => {
      const parsed = parseSwapInstrumentId(EVM_EXACT_ID);
      expect(parsed.displaySymbol).toBe('WETH/USDC');
      expect(parsed.baseAddress).toBe(BASE_WETH_ADDR);
      expect(parsed.quoteAddress).toBe(BASE_USDC_ADDR);
      expect(parsed.isExact).toBe(true);
    });
  });

  // ── validateTradeInstrument (Jupiter) ───────────────────────────────────

  describe('validateTradeInstrument — Jupiter', () => {
    it('validates Solana exact pair when both mints are cached', () => {
      const cache = makeCache(true, {
        jupiter: new Set([SOL_BONK_MINT, SOL_USDC_MINT]),
      });
      const result = validateTradeInstrument('jupiter', SOL_EXACT_ID, cache);
      expect(result.valid).toBe(true);
    });

    it('rejects Solana exact pair when base mint is missing', () => {
      const cache = makeCache(true, {
        jupiter: new Set([SOL_USDC_MINT]),
      });
      const result = validateTradeInstrument('jupiter', SOL_EXACT_ID, cache);
      expect(result.valid).toBe(false);
    });
  });

  // ── validateTradeInstrument (1inch) ─────────────────────────────────────

  describe('validateTradeInstrument — 1inch', () => {
    it('validates EVM exact pair with canonical USDC on Base', () => {
      const result = validateTradeInstrument('1inch', EVM_EXACT_ID, makeCache(false), {
        oneInchConfig: { chainId: 8453 },
        canonicalTokens: {
          base: {
            USDC: { address: BASE_USDC_ADDR, name: 'USD Coin', aliases: [] as string[] },
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects EVM exact pair when quote mismatches canonical USDC', () => {
      const result = validateTradeInstrument('1inch', EVM_EXACT_ID, makeCache(false), {
        oneInchConfig: { chainId: 8453 },
        canonicalTokens: {
          base: {
            USDC: { address: '0x0000000000000000000000000000000000000001', name: 'Fake', aliases: [] as string[] },
          },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not match canonical USDC address');
    });
  });
});
