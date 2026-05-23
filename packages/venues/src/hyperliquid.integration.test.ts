import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HyperliquidAdapter } from './hyperliquid.js';

/**
 * Integration test for HyperliquidAdapter.
 * Requires HYPERLIQUID_TESTNET_API_KEY and HYPERLIQUID_TESTNET_SECRET env vars.
 * Run manually: HYPERLIQUID_TESTNET_API_KEY=xxx HYPERLIQUID_TESTNET_SECRET=xxx pnpm test
 */
const API_KEY = process.env['HYPERLIQUID_TESTNET_API_KEY'];
const SECRET = process.env['HYPERLIQUID_TESTNET_SECRET'];
const SKIP = !API_KEY || !SECRET;

describe.skipIf(SKIP)('HyperliquidAdapter (testnet integration)', () => {
  let adapter: HyperliquidAdapter;

  beforeAll(() => {
    adapter = new HyperliquidAdapter({
      credentials: {
        apiKey: API_KEY!,
        secret: SECRET!,
        testnet: true,
      },
    });
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('fetches balances', async () => {
    const result = await adapter.fetchBalances();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.timestamp).toBeDefined();
      expect(Array.isArray(result.data.balances)).toBe(true);
    }
  });

  it('fetches positions', async () => {
    const result = await adapter.fetchPositions();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data)).toBe(true);
    }
  });
});
