import { describe, it, expect } from 'vitest';
import { resolveSwapAssetsFromBinding } from './resolve-swap-assets.js';

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
