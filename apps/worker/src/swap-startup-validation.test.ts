import { describe, it, expect } from 'vitest';
import { validateSwapScannerConfig } from './swap-startup-validation.js';
import type { TechnicalConfig } from '@herobids/domain';

function makeTechnicalConfig(overrides: Partial<TechnicalConfig['filters']> = {}): TechnicalConfig {
  return {
    filters: {
      venue: 'jupiter',
      venueType: 'swap',
      quoteAssetSymbol: 'USDC',
      networks: [],
      minLiquidityUsd: 10_000,
      minVolume24hUsd: 25_000,
      ...overrides,
    },
    indicators: {
      regime: { emaFast: 20, emaSlow: 50, emaTrend: 200, adxPeriod: 14, adxThreshold: 25 },
      sentiment: { enabled: false },
    },
    candles: { interval: '1h', limit: 100 },
    signalBias: 'trend-following',
    scanIntervalMs: 60_000,
    scanBatchSize: 5,
    autonomousExit: false,
  };
}

const CANONICAL_TOKENS = {
  solana: {
    USDC: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin', aliases: [] },
    SOL: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', aliases: [] },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', name: 'USD Coin', aliases: [] },
  },
};

// ─── Canonical token resolution ────────────────────────────────────────────────

describe('validateSwapScannerConfig', () => {
  it('returns ok with resolved network and quote when all checks pass', () => {
    const techConfig = makeTechnicalConfig({ quoteAssetSymbol: 'USDC' });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.network).toBe('solana');
      expect(result.data.quoteAssetSymbol).toBe('USDC');
    }
  });

  it('defaults quoteAssetSymbol to USDC when not specified', () => {
    const techConfig = makeTechnicalConfig({ quoteAssetSymbol: undefined });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.quoteAssetSymbol).toBe('USDC');
    }
  });

  // ─── Unresolved network ─────────────────────────────────────────────────

  it('fails when network is unresolved', () => {
    const techConfig = makeTechnicalConfig();
    const result = validateSwapScannerConfig(undefined, '1inch', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.network_unresolved');
      expect(result.error.message).toContain('1inch');
    }
  });

  // ─── Network exclusion ──────────────────────────────────────────────────

  it('fails when filters.networks excludes the binding network', () => {
    const techConfig = makeTechnicalConfig({ networks: ['base'] });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.network_excluded');
      expect(result.error.message).toContain('solana');
      expect(result.error.message).toContain('base');
    }
  });

  it('passes when filters.networks includes the binding network', () => {
    const techConfig = makeTechnicalConfig({ networks: ['solana', 'base'] });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
  });

  it('passes when filters.networks is empty', () => {
    const techConfig = makeTechnicalConfig({ networks: [] });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
  });

  it('passes when filters.networks is undefined', () => {
    const techConfig = makeTechnicalConfig({ networks: undefined });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
  });

  // ─── Missing canonical tokens ────────────────────────────────────────────

  it('fails when canonicalTokens is undefined', () => {
    const techConfig = makeTechnicalConfig();
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.no_canonical_tokens');
      expect(result.error.message).toContain('solana');
    }
  });

  it('fails when canonicalTokens has no entry for the network', () => {
    const techConfig = makeTechnicalConfig();
    const result = validateSwapScannerConfig('arbitrum' as any, '1inch', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.no_canonical_tokens');
      expect(result.error.message).toContain('arbitrum');
    }
  });

  it('fails when canonicalTokens entry for network is empty', () => {
    const techConfig = makeTechnicalConfig();
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, { solana: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.no_canonical_tokens');
    }
  });

  // ─── Quote asset validation ──────────────────────────────────────────────

  it('fails when quoteAssetSymbol is not a canonical token', () => {
    const techConfig = makeTechnicalConfig({ quoteAssetSymbol: 'EURC' });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('swap.quote_not_canonical');
      expect(result.error.message).toContain('EURC');
      expect(result.error.message).toContain('USDC');
    }
  });

  it('passes with non-default quote asset when it is canonical', () => {
    const techConfig = makeTechnicalConfig({ quoteAssetSymbol: 'SOL' });
    const result = validateSwapScannerConfig('solana', 'jupiter', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.quoteAssetSymbol).toBe('SOL');
    }
  });

  // ─── Cross-venue coverage ───────────────────────────────────────────────

  it('works for 1inch venue on base network', () => {
    const techConfig = makeTechnicalConfig({ quoteAssetSymbol: 'USDC' });
    const result = validateSwapScannerConfig('base', '1inch', techConfig, CANONICAL_TOKENS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.network).toBe('base');
    }
  });
});
