import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageBillingRepository, computeSpendStatus } from './usage-billing-repository.js';
import type { InsertUsageEvent } from './usage-billing-repository.js';
import type { Database } from './index.js';
import type { ProvidersYaml } from '@herobids/domain';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Build a Drizzle-style query chain that resolves to `rows` when awaited.
 * All chain methods return the same chain object so any call sequence works.
 */
function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain['set'] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => Promise.resolve(undefined));
  return chain;
}

function makeInsertChain(onInsert?: (values: unknown) => void) {
  const chain: Record<string, unknown> = {};
  chain['values'] = vi.fn((v) => {
    onInsert?.(v);
    return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
  });
  return chain;
}

// ── LLM pricing snapshot tests ────────────────────────────────────────────────

const MOCK_SNAPSHOT = {
  id: 'openrouter_2026-01-01T00:00:00.000Z',
  provider: 'openrouter',
  fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
  models: {
    'openai/gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 },
    'anthropic/claude-sonnet-4-5': { inputUsdPerM: 3, outputUsdPerM: 15 },
  },
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('getLatestPricingSnapshot', () => {
  it('returns the active snapshot row when one exists', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([MOCK_SNAPSHOT])),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.getLatestPricingSnapshot('openrouter');
    expect(result).toEqual(MOCK_SNAPSHOT);
  });

  it('returns null when no active snapshot exists for the provider', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([])),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.getLatestPricingSnapshot('anthropic');
    expect(result).toBeNull();
  });
});

describe('upsertPricingSnapshot', () => {
  it('deactivates old active rows and inserts the new snapshot in a transaction', async () => {
    const updateCalls: unknown[] = [];
    const insertedRows: unknown[] = [];

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([])),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockImplementation((w) => {
                updateCalls.push(w);
                return Promise.resolve(undefined);
              }),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((v) => {
              insertedRows.push(v);
              return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
            }),
          }),
        };
        return fn(tx);
      }),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    await repo.upsertPricingSnapshot({
      id: 'openrouter_2026-01-01T00:00:00.000Z',
      provider: 'openrouter',
      fetchedAt: new Date('2026-01-01T00:00:00.000Z'),
      models: { 'openai/gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 } },
    });

    expect(db.transaction).toHaveBeenCalledOnce();
    // Deactivation update was issued
    expect(updateCalls).toHaveLength(1);
    // New row was inserted
    expect(insertedRows).toHaveLength(1);
    const inserted = insertedRows[0] as Record<string, unknown>;
    expect(inserted['id']).toBe('openrouter_2026-01-01T00:00:00.000Z');
    expect(inserted['provider']).toBe('openrouter');
    expect(inserted['isActive']).toBe(true);
    expect(inserted['fetchedAt']).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('sets fetchedAt to null for static seed snapshots', async () => {
    const insertedRows: unknown[] = [];

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([])),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((v) => {
              insertedRows.push(v);
              return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
            }),
          }),
        };
        return fn(tx);
      }),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    await repo.upsertPricingSnapshot({
      id: 'seed_openai_v1',
      provider: 'openai',
      fetchedAt: null,
      models: { 'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 } },
    });

    const inserted = insertedRows[0] as Record<string, unknown>;
    expect(inserted['fetchedAt']).toBeNull();
  });
});

describe('seedDefaultRateCardItems with providers', () => {
  const mockProviders: ProvidersYaml = {
    providers: {
      openrouter: { catalogMode: 'dynamic', isMultiProvider: true, models: {} },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeds per-model rate card items from active pricing snapshots when providers are configured', async () => {
    const insertedItems: Array<Record<string, unknown>> = [];

    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        // Call 1: getActiveRateCard → existing rate card found
        // Call 2+: getLatestPricingSnapshot → returns snapshot with two models
        return makeSelectChain(
          selectCallCount === 1
            ? [{ id: 'rc_default_v1' }]
            : [MOCK_SNAPSHOT],
        );
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((items: unknown) => {
          const arr = Array.isArray(items) ? items : [items];
          insertedItems.push(...(arr as Array<Record<string, unknown>>));
          return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db, undefined, mockProviders);
    await repo.ensureActiveRateCard('default');

    const modelItems = insertedItems.filter((item) => item['metadata'] !== null && (item['metadata'] as Record<string, unknown>)?.['seed'] === 'model_pricing_v1');
    expect(modelItems.length).toBeGreaterThan(0);

    // $2.5/M input → 2500 µUSD per 1000 tokens
    const inputItem = modelItems.find(
      (item) => item['meterKey'] === 'llm.input_tokens' && item['modelPattern'] === 'openai/gpt-4o',
    );
    expect(inputItem).toBeDefined();
    expect(inputItem!['provider']).toBe('openrouter');
    expect(inputItem!['priceMicrousd']).toBe(2500);
    expect(inputItem!['perUnit']).toBe(1000);
  });

  it('omits per-model items when no providers registry is configured', async () => {
    const insertedItems: Array<Record<string, unknown>> = [];

    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([{ id: 'rc_default_v1' }])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((items: unknown) => {
          const arr = Array.isArray(items) ? items : [items];
          insertedItems.push(...(arr as Array<Record<string, unknown>>));
          return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    } as unknown as Database;

    // No providers passed — only catch-all items seeded
    const repo = new UsageBillingRepository(db);
    await repo.ensureActiveRateCard('default');

    const modelItems = insertedItems.filter((item) => item['metadata'] !== null && (item['metadata'] as Record<string, unknown>)?.['seed'] === 'model_pricing_v1');
    expect(modelItems).toHaveLength(0);
  });
});

// ── computeCharge tests (via rateAndApplyUsageEvents) ────────────────────────

describe('computeCharge (via rateAndApplyUsageEvents)', () => {
  type RateCardItem = Parameters<UsageBillingRepository['rateAndApplyUsageEvents']>[3][number];

  function makeRateCardItem(overrides: Partial<RateCardItem> = {}): RateCardItem {
    return {
      id: 'rci_test',
      rateCardId: 'rc_1',
      meterKey: 'llm.input_tokens',
      provider: 'openrouter',
      modelPattern: 'deepseek/deepseek-v4-flash',
      priceMicrousd: 90,
      perUnit: 1000,
      roundingMode: 'up',
      minimumChargeMicrousd: null,
      metadata: null,
      ...overrides,
    } as RateCardItem;
  }

  function makeEvent(overrides: Partial<InsertUsageEvent> = {}): InsertUsageEvent {
    return {
      id: 'evt_test',
      accountId: 'acc_1',
      userId: 'user_1',
      meterKey: 'llm.input_tokens',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      quantity: 1000,
      unit: 'tokens',
      idempotencyKey: 'idem_test',
      occurredAt: new Date(),
      ...overrides,
    };
  }

  function makeDb() {
    const tx = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const db = {
      transaction: vi.fn().mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
      ),
    } as unknown as Database;
    return { db, tx };
  }

  it('does not charge when event has no model and rate card item is model-specific', async () => {
    const { db } = makeDb();
    const repo = new UsageBillingRepository(db);
    const items = [makeRateCardItem()]; // modelPattern = 'deepseek/deepseek-v4-flash'
    const event = makeEvent({ model: null });

    const charge = await repo.rateAndApplyUsageEvents([event], 'period_1', 'acc_1', items);
    expect(charge).toBe(0);
    // No DB writes when charge is zero
    expect((db as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });

  it('charges against a catch-all item (no modelPattern) even when event has no model', async () => {
    const { db } = makeDb();
    const repo = new UsageBillingRepository(db);
    const items = [makeRateCardItem({ modelPattern: null, provider: null })]; // catch-all
    const event = makeEvent({ model: null });

    const charge = await repo.rateAndApplyUsageEvents([event], 'period_1', 'acc_1', items);
    // 1000 tokens × 90 µUSD/1000 = 90 µUSD
    expect(charge).toBe(90);
  });

  it('charges correctly when event model matches the rate card item exactly', async () => {
    const { db } = makeDb();
    const repo = new UsageBillingRepository(db);
    const items = [makeRateCardItem()];
    const event = makeEvent(); // model = 'deepseek/deepseek-v4-flash'

    const charge = await repo.rateAndApplyUsageEvents([event], 'period_1', 'acc_1', items);
    expect(charge).toBe(90);
  });

  it('charges correctly when event carries a dated model ID and rate card has the undated pattern', async () => {
    const { db } = makeDb();
    const repo = new UsageBillingRepository(db);
    const items = [makeRateCardItem()]; // modelPattern = 'deepseek/deepseek-v4-flash'
    const event = makeEvent({ model: 'deepseek/deepseek-v4-flash-20260423' }); // dated

    const charge = await repo.rateAndApplyUsageEvents([event], 'period_1', 'acc_1', items);
    expect(charge).toBe(90);
  });

  it('prefers the model-specific rate over a catch-all when only the stripped model ID matches', async () => {
    // Regression: when a dated model ID (e.g. -20260423) is present and there is both
    // a catch-all item AND an undated model-specific item, the dated event must be
    // charged at the model-specific rate, not the catch-all rate.
    const { db } = makeDb();
    const repo = new UsageBillingRepository(db);
    const items = [
      makeRateCardItem({ modelPattern: null, provider: null, priceMicrousd: 50 }), // catch-all: 50 µUSD/1K
      makeRateCardItem({ priceMicrousd: 90 }),                                      // model-specific: 90 µUSD/1K
    ];
    const event = makeEvent({ model: 'deepseek/deepseek-v4-flash-20260423' }); // dated

    const charge = await repo.rateAndApplyUsageEvents([event], 'period_1', 'acc_1', items);
    // 1000 tokens × 90 µUSD/1000 = 90, not 50 (catch-all must lose to model-specific)
    expect(charge).toBe(90);
  });
});

// ── computeSpendStatus tests ──────────────────────────────────────────────────

function makePeriod(overrides: {
  balanceMicrousd?: number;
  hardCapMicrousd?: number | null;
  softCapMicrousd?: number | null;
  includedCreditMicrousd?: number;
  usageChargeMicrousd?: number;
} = {}) {
  return {
    balanceMicrousd: 20_000_000,     // $20.00 (starter plan included credit)
    hardCapMicrousd: 0,               // $0.00 cap (starter plan default)
    softCapMicrousd: 0,               // $0.00 cap (starter plan default)
    includedCreditMicrousd: 20_000_000,
    usageChargeMicrousd: 0,
    ...overrides,
  };
}

describe('computeSpendStatus', () => {
  it('returns active when balance is positive and hardCap is 0', () => {
    // Starter plan: $20 included, $0 spent → balance = $20
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: 20_000_000 }));
    expect(status).toBe('active');
  });

  it('returns active when balance is exactly 0 and hardCap is 0', () => {
    // User spent exactly their included credit + top-ups → balance = 0
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: 0 }));
    expect(status).toBe('active');
  });

  it('returns hard_limited when balance is negative and hardCap is 0', () => {
    // User overspent by $0.01 → balance = -$0.01 → netOutOfPocket = $0.01 > $0
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: -100 }));
    expect(status).toBe('hard_limited');
  });

  it('returns hard_limited when netOutOfPocket exceeds a non-zero hardCap', () => {
    // hardCap = $5.00 (500 cents), balance = -$6.00 → netOutOfPocket = $6.00 > $5.00
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -60_000,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('hard_limited');
  });

  it('returns active when netOutOfPocket equals a non-zero hardCap', () => {
    // hardCap = $5.00, balance = -$5.00 → netOutOfPocket = $5.00, not > $5.00
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -50_000,
      softCapMicrousd: null,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('active');
  });

  it('returns active when netOutOfPocket is below a non-zero hardCap', () => {
    // hardCap = $5.00, balance = -$3.00 → netOutOfPocket = $3.00 < $5.00
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -30_000,
      softCapMicrousd: null,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('active');
  });

  it('returns soft_limited when netOutOfPocket exceeds softCap but not hardCap', () => {
    // softCap = $2.00, hardCap = $5.00, balance = -$3.00 → netOutOfPocket = $3.00
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -30_000,
      softCapMicrousd: 20_000,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('soft_limited');
  });

  it('returns hard_limited when netOutOfPocket exceeds both caps (hard check wins)', () => {
    // softCap = $2.00, hardCap = $5.00, balance = -$6.00 → netOutOfPocket = $6.00
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -60_000,
      softCapMicrousd: 20_000,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('hard_limited');
  });

  it('returns active when hardCap is null (no cap set)', () => {
    // hardCap null → no enforcement, even with negative balance
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -100_000,
      softCapMicrousd: null,
      hardCapMicrousd: null,
    }));
    expect(status).toBe('active');
  });

  it('returns active when softCap is null (no soft cap set)', () => {
    // softCap null → skip soft check, even with negative balance below hardCap threshold
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -10_000,
      softCapMicrousd: null,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('active');
  });

  it('returns active when both caps are null (free plan pre-cap config)', () => {
    // No caps configured → always active regardless of balance
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -500_000,
      hardCapMicrousd: null,
      softCapMicrousd: null,
    }));
    expect(status).toBe('active');
  });

  it('top-up that restores positive balance unblocks a hard-limited account', () => {
    // Before top-up: balance = -$1.00 → hard_limited
    const before = computeSpendStatus(makePeriod({ balanceMicrousd: -10_000 }));
    expect(before).toBe('hard_limited');

    // After $5 top-up (adds 50,000 microusd): balance = $4.00 → active
    const after = computeSpendStatus(makePeriod({ balanceMicrousd: 40_000 }));
    expect(after).toBe('active');
  });

  it('top-up that partially restores balance but still negative keeps hard-limited', () => {
    // Before top-up: balance = -$10.00 → hard_limited
    // After $5 top-up: balance = -$5.00 → still negative → still hard_limited
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: -50_000 }));
    expect(status).toBe('hard_limited');
  });
});
