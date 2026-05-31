/**
 * rollout-smoke-test.ts — Programmatic Hyperliquid testnet smoke test.
 *
 * Validates connectivity and basic order submission/cancel flow against
 * Hyperliquid testnet using the venue adapter directly (no API/worker required).
 *
 * This is useful to verify credentials and network connectivity before
 * running the full Stage A script.
 *
 * Prerequisites:
 *   export HYPERLIQUID_TESTNET_API_KEY=<your-testnet-key>
 *   export HYPERLIQUID_TESTNET_SECRET=<your-testnet-secret>
 *
 * Usage:
 *   npx tsx scripts/ts/rollout-smoke-test.ts
 *
 * What this tests:
 *   1. Exchange connectivity (load markets)
 *   2. Balance fetch
 *   3. Ticker fetch (ETH/USD:USD)
 *   4. Market order submission (tiny size)
 *   5. Open orders fetch
 *   6. Positions fetch
 *   7. Recent fills fetch
 */
import { HyperliquidAdapter } from '@herobids/venues';

const API_KEY = process.env['HYPERLIQUID_TESTNET_API_KEY'];
const SECRET = process.env['HYPERLIQUID_TESTNET_SECRET'];
const SYMBOL = process.env['ROLLOUT_SYMBOL'] ?? 'ETH/USD:USD';

if (!API_KEY || !SECRET) {
  console.error('Missing env vars: HYPERLIQUID_TESTNET_API_KEY, HYPERLIQUID_TESTNET_SECRET');
  process.exit(1);
}

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail, durationMs: Date.now() - start });
    console.log(`  ✓ ${name} (${Date.now() - start}ms) — ${detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail: msg, durationMs: Date.now() - start });
    console.log(`  ✗ ${name} (${Date.now() - start}ms) — ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('=== Hyperliquid Testnet Smoke Test ===');
  console.log(`  Symbol: ${SYMBOL}`);
  console.log('');

  const adapter = new HyperliquidAdapter({
    credentials: { apiKey: API_KEY, secret: SECRET, testnet: true },
    streamConfig: { reconnectBaseMs: 1000, reconnectMaxMs: 5000, maxReconnectAttempts: 3 },
  });

  // Test 1: Fetch ticker (proves connectivity)
  await runTest('Fetch ticker', async () => {
    const ticker = await adapter.fetchTicker(SYMBOL);
    if (!ticker.ok) throw new Error(`Ticker fetch failed: ${ticker.error.message}`);
    const t = ticker.data;
    return `bid=${t.bid} ask=${t.ask} last=${t.last}`;
  });

  // Test 2: Fetch balances
  await runTest('Fetch balances', async () => {
    const balances = await adapter.fetchBalances();
    if (!balances.ok) throw new Error(`Balance fetch failed: ${balances.error.message}`);
    const total = balances.data.reduce((sum, b) => sum + Number(b.free.toString()) + Number(b.locked.toString()), 0);
    return `${balances.data.length} assets, total≈${total.toFixed(2)}`;
  });

  // Test 3: Fetch positions
  await runTest('Fetch positions', async () => {
    const positions = await adapter.fetchPositions();
    if (!positions.ok) throw new Error(`Positions fetch failed: ${positions.error.message}`);
    const open = positions.data.filter(p => Number(p.size.toString()) !== 0);
    return `${open.length} open positions`;
  });

  // Test 4: Fetch open orders
  await runTest('Fetch open orders', async () => {
    const orders = await adapter.fetchOpenOrders(SYMBOL);
    if (!orders.ok) throw new Error(`Open orders fetch failed: ${orders.error.message}`);
    return `${orders.data.length} open orders`;
  });

  // Test 5: Submit a market order (minimum size)
  let orderId: string | undefined;
  await runTest('Submit market order (buy 0.001)', async () => {
    const { quantity } = await import('@herobids/domain');
    const result = await adapter.submitOrder({
      symbol: SYMBOL,
      side: 'buy',
      type: 'market',
      quantity: quantity('0.001'),
      clientOrderId: `smoke-test-${Date.now()}`,
    });
    if (!result.ok) throw new Error(`Order submit failed: ${result.error.message}`);
    orderId = result.data.venueRefId;
    return `orderId=${result.data.orderId} venueRef=${result.data.venueRefId} status=${result.data.status}`;
  });

  // Test 6: Fetch recent fills
  await runTest('Fetch recent fills', async () => {
    // Small delay for fill to propagate
    await new Promise(r => setTimeout(r, 2000));
    const fills = await adapter.fetchRecentFills(SYMBOL);
    if (!fills.ok) throw new Error(`Fills fetch failed: ${fills.error.message}`);
    return `${fills.data.length} recent fills`;
  });

  // Test 7: If we have a position, try to close it
  await runTest('Close position (sell 0.001)', async () => {
    const { quantity } = await import('@herobids/domain');
    const result = await adapter.submitOrder({
      symbol: SYMBOL,
      side: 'sell',
      type: 'market',
      quantity: quantity('0.001'),
      clientOrderId: `smoke-close-${Date.now()}`,
    });
    if (!result.ok) throw new Error(`Close order failed: ${result.error.message}`);
    return `orderId=${result.data.orderId} status=${result.data.status}`;
  });

  // Summary
  console.log('');
  console.log('=== Summary ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);
  console.log('');

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    });
    process.exit(1);
  } else {
    console.log('All tests passed — testnet credentials and connectivity verified.');
    console.log('Safe to proceed with Stage A (./scripts/shell/rollout/rollout-stage-a.sh)');
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
