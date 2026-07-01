import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DcaStrategy } from './dca-strategy.js';
import type { MarketSnapshot } from '@herobids/domain';
import { price } from '@herobids/domain';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SYMBOL = 'BTC/USDT';

const BASE_SNAPSHOT: MarketSnapshot = {
  symbol: SYMBOL,
  price: price('50000'),
  timestamp: '2026-01-01T00:00:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DcaStrategy', () => {
  let strategy: DcaStrategy;

  beforeEach(() => {
    vi.useFakeTimers();
    strategy = new DcaStrategy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns go_long decision with correct amount when no prior buy', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, { amountPerBuy: '50' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
      expect(result.data?.targetSize.toString()).toBe('50');
      expect(result.data?.actorId).toBe('dca-v1');
      expect(result.data?.metadata).toMatchObject({ strategy: 'dca' });
    }
  });

  it('returns null when within interval', async () => {
    const now = Date.now();
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { lastDcaBuy: now },
    };

    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '50',
      intervalMs: 86_400_000, // 1 day
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns go_long after interval has passed', async () => {
    const oneDayMs = 86_400_000;
    const lastBuy = Date.now() - oneDayMs - 1; // just over a day ago
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { lastDcaBuy: lastBuy },
    };

    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '50',
      intervalMs: oneDayMs,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
    }
  });

  it('rejects invalid config (missing amountPerBuy)', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.config_invalid');
    }
  });

  it('rejects invalid amountPerBuy (non-numeric string)', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, {
      amountPerBuy: 'not-a-number',
      intervalMs: 3_600_000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.config_invalid');
    }
  });

  it('uses default intervalMs when not provided', async () => {
    const oneDayMs = 86_400_000;
    const lastBuy = Date.now() - oneDayMs - 1; // just over a day ago
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { lastDcaBuy: lastBuy },
    };

    // No intervalMs provided — should default to 86_400_000 (1 day)
    const result = await strategy.evaluate(snapshot, { amountPerBuy: '50' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
    }
  });

  // ─── percent_equity mode ───────────────────────────────────────────────────

  it('computes correct buy amount from percent-equity with valid equity', async () => {
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { accountEquity: 10_000 },
    };

    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '5',
      amountPerBuyMode: 'percent_equity',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
      // 5% of $10,000 = $500.00 (quantity normalizes trailing zeros)
      expect(result.data?.targetSize.toString()).toBe('500');
    }
  });

  it('returns null when accountEquity is missing in percent-equity mode', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, {
      amountPerBuy: '5',
      amountPerBuyMode: 'percent_equity',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns null when accountEquity is zero in percent-equity mode', async () => {
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { accountEquity: 0 },
    };

    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '5',
      amountPerBuyMode: 'percent_equity',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns null when accountEquity is negative in percent-equity mode', async () => {
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { accountEquity: -100 },
    };

    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '5',
      amountPerBuyMode: 'percent_equity',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns null when computed percent-equity amount is too small', async () => {
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { accountEquity: 1 }, // 5% of $1 = $0.05, still >= 0.01 threshold
    };

    // Use a tiny percentage so computed amount falls below 0.01 threshold
    const result = await strategy.evaluate(snapshot, {
      amountPerBuy: '0.5',
      amountPerBuyMode: 'percent_equity',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 0.5% of $1 = $0.005 < 0.01 threshold
      expect(result.data).toBeNull();
    }
  });

  it('fixed mode still works as before', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, {
      amountPerBuy: '50',
      amountPerBuyMode: 'fixed',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
      expect(result.data?.targetSize.toString()).toBe('50');
    }
  });

  it('defaults amountPerBuyMode to fixed when not provided', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, { amountPerBuy: '50' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
      // fixed mode — uses amountPerBuy directly
      expect(result.data?.targetSize.toString()).toBe('50');
    }
  });

  it('rejects invalid amountPerBuyMode', async () => {
    const result = await strategy.evaluate(BASE_SNAPSHOT, {
      amountPerBuy: '50',
      amountPerBuyMode: 'invalid',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.config_invalid');
    }
  });
});
