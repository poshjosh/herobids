import { describe, it, expect } from 'vitest';
import { resolveSwapAssetsFromBinding, resolveSwapNetwork } from './resolve-swap-assets.js';

describe('resolveSwapAssetsFromBinding', () => {
  it('returns undefined when bindingProfile is null', () => {
    expect(resolveSwapAssetsFromBinding({ id: 'b-1', bindingProfile: null })).toBeUndefined();
  });

  it('returns undefined when bindingProfile is missing', () => {
    expect(resolveSwapAssetsFromBinding({ id: 'b-1' })).toBeUndefined();
  });

  it('extracts from nested swapAssets object', () => {
    const binding = {
      id: 'b-1',
      bindingProfile: {
        swapAssets: {
          baseAsset: 'So11111111111111111111111111111111111111112',
          quoteAsset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          baseDecimals: 9,
          quoteDecimals: 6,
        },
      },
    };
    expect(resolveSwapAssetsFromBinding(binding)).toEqual({
      baseAsset: 'So11111111111111111111111111111111111111112',
      quoteAsset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      baseDecimals: 9,
      quoteDecimals: 6,
    });
  });

  it('extracts from flat layout in bindingProfile', () => {
    const binding = {
      id: 'b-2',
      bindingProfile: {
        baseAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        quoteAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        baseDecimals: 18,
        quoteDecimals: 6,
      },
    };
    expect(resolveSwapAssetsFromBinding(binding)).toEqual({
      baseAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      quoteAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      baseDecimals: 18,
      quoteDecimals: 6,
    });
  });

  it('returns undefined when required fields are missing', () => {
    const binding = {
      id: 'b-3',
      bindingProfile: { baseAsset: 'SOL' }, // incomplete
    };
    expect(resolveSwapAssetsFromBinding(binding)).toBeUndefined();
  });

  it('returns undefined when decimals are not numbers', () => {
    const binding = {
      id: 'b-4',
      bindingProfile: {
        baseAsset: 'SOL',
        quoteAsset: 'USDC',
        baseDecimals: '9', // string, not number
        quoteDecimals: 6,
      },
    };
    expect(resolveSwapAssetsFromBinding(binding)).toBeUndefined();
  });

  it('prefers nested swapAssets over flat layout', () => {
    const binding = {
      id: 'b-5',
      bindingProfile: {
        baseAsset: 'WRONG',
        quoteAsset: 'WRONG',
        baseDecimals: 0,
        quoteDecimals: 0,
        swapAssets: {
          baseAsset: 'CORRECT_BASE',
          quoteAsset: 'CORRECT_QUOTE',
          baseDecimals: 9,
          quoteDecimals: 6,
        },
      },
    };
    const result = resolveSwapAssetsFromBinding(binding);
    expect(result?.baseAsset).toBe('CORRECT_BASE');
    expect(result?.quoteAsset).toBe('CORRECT_QUOTE');
  });
});

describe('resolveSwapNetwork', () => {
  it('returns solana for jupiter', () => {
    expect(resolveSwapNetwork('jupiter')).toBe('solana');
  });

  it('returns undefined for non-swap venues', () => {
    expect(resolveSwapNetwork('hyperliquid')).toBeUndefined();
    expect(resolveSwapNetwork('bybit')).toBeUndefined();
  });

  it('reads network directly from binding profile', () => {
    const binding = {
      id: 'b-1',
      bindingProfile: { network: 'ethereum' },
    };
    expect(resolveSwapNetwork('1inch', binding)).toBe('ethereum');
  });

  it('maps chainId from binding profile via inferOneInchTokenSafetyNetwork', () => {
    const binding = {
      id: 'b-2',
      bindingProfile: { chainId: 42161 },
    };
    expect(resolveSwapNetwork('1inch', binding)).toBe('arbitrum');
  });

  it('binding profile network takes precedence over chainId', () => {
    const binding = {
      id: 'b-3',
      bindingProfile: { network: 'polygon', chainId: 42161 },
    };
    expect(resolveSwapNetwork('1inch', binding)).toBe('polygon');
  });

  it('falls back to operator config tokenSafetyNetwork when binding has no chain info', () => {
    expect(resolveSwapNetwork('1inch', undefined, { tokenSafetyNetwork: 'base' })).toBe('base');
  });

  it('falls back to operator config chainId when binding has no chain info', () => {
    expect(resolveSwapNetwork('1inch', undefined, { chainId: 1 })).toBe('ethereum');
  });

  it('binding profile wins over operator config', () => {
    const binding = {
      id: 'b-4',
      bindingProfile: { network: 'arbitrum' },
    };
    expect(resolveSwapNetwork('1inch', binding, { tokenSafetyNetwork: 'base', chainId: 8453 })).toBe('arbitrum');
  });

  it('binding chainId overrides operator chainId (regression)', () => {
    // Binding has chainId 42161 (Arbitrum), operator config has chainId 8453 (Base).
    // The binding's chainId must win — we must not silently route to Base.
    const binding = {
      id: 'b-regression-1',
      bindingProfile: { chainId: 42161 },
    };
    expect(resolveSwapNetwork('1inch', binding, { chainId: 8453 })).toBe('arbitrum');
  });

  it('returns undefined when no chain info anywhere', () => {
    expect(resolveSwapNetwork('1inch')).toBeUndefined();
  });

  it('returns undefined for unsupported binding chainId', () => {
    const binding = {
      id: 'b-5',
      bindingProfile: { chainId: 99999 },
    };
    // Fail closed — explicit but unsupported chain must not fall back to operator config
    expect(resolveSwapNetwork('1inch', binding, { chainId: 8453 })).toBeUndefined();
  });

  it('falls through for invalid binding profile network string', () => {
    const binding = {
      id: 'b-6',
      bindingProfile: { network: 'nonexistent' },
    };
    // Invalid network string → skip tier 1, fall to operator config tier 3
    expect(resolveSwapNetwork('1inch', binding, { tokenSafetyNetwork: 'base' })).toBe('base');
  });

  it('valid binding profile network wins', () => {
    const binding = {
      id: 'b-7',
      bindingProfile: { network: 'polygon' },
    };
    expect(resolveSwapNetwork('1inch', binding, { tokenSafetyNetwork: 'base' })).toBe('polygon');
  });
});
