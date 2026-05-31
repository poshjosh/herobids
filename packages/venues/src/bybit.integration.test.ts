import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BybitAdapter } from './bybit.js';

/**
 * Integration test for BybitAdapter.
 * Requires BYBIT_TESTNET_API_KEY and BYBIT_TESTNET_SECRET env vars.
 * Run manually: BYBIT_TESTNET_API_KEY=xxx BYBIT_TESTNET_SECRET=xxx pnpm test
 */
const API_KEY = process.env['BYBIT_TESTNET_API_KEY'];
const SECRET = process.env['BYBIT_TESTNET_SECRET'];
const SKIP = !API_KEY || !SECRET;

describe.skipIf(SKIP)('BybitAdapter (testnet integration)', () => {
  let adapter: BybitAdapter;

  beforeAll(() => {
    adapter = new BybitAdapter({
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
