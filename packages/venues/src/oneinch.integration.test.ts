import { describe, it, expect } from 'vitest';

/**
 * Integration tests for OneInchSwapAdapter.
 * These tests require network access and valid API keys.
 * Skipped in CI — run manually with:
 *   ONEINCH_API_KEY=... BASE_RPC_URL=... pnpm vitest run packages/venues/src/oneinch.integration.test.ts
 */
describe.skip('OneInch integration', () => {
  it('fetches a quote for USDC→WETH on Base', async () => {
    const { OneInchSwapAdapter } = await import('./oneinch-swap.js');
    const { quantity } = await import('@herobids/domain');

    const adapter = new OneInchSwapAdapter({
      apiUrl: 'https://api.1inch.dev/swap/v6.0/8453',
      apiKey: process.env['ONEINCH_API_KEY']!,
      signer: {
        privateKey: process.env['ONEINCH_PRIVATE_KEY']!,
        rpcUrl: process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org',
        chainId: 8453,
        confirmationTimeoutMs: 60_000,
      },
      tokenDecimals: {
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC on Base
        '0x4200000000000000000000000000000000000006': 18, // WETH on Base
      },
    });

    const result = await adapter.quote({
      inputAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
      outputAsset: '0x4200000000000000000000000000000000000006', // WETH
      amount: quantity('10'), // 10 USDC
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.inputAsset).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
      expect(result.data.outputAsset).toBe('0x4200000000000000000000000000000000000006');
      expect(result.data.expectedOutputAmount.gt(0)).toBe(true);
      expect(result.data.minimumOutputAmount.gt(0)).toBe(true);
    }
  });

  it('fetches ERC-20 balances', async () => {
    const { OneInchSwapAdapter } = await import('./oneinch-swap.js');

    const adapter = new OneInchSwapAdapter({
      apiUrl: 'https://api.1inch.dev/swap/v6.0/8453',
      apiKey: process.env['ONEINCH_API_KEY']!,
      signer: {
        privateKey: process.env['ONEINCH_PRIVATE_KEY']!,
        rpcUrl: process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org',
        chainId: 8453,
        confirmationTimeoutMs: 60_000,
      },
      tokenDecimals: {
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6, // USDC on Base
      },
    });

    const result = await adapter.fetchBalances();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.timestamp).toBeDefined();
      expect(Array.isArray(result.data.balances)).toBe(true);
    }
  });
});
