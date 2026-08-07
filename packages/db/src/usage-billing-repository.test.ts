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
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'offset']) {
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
  chain['where'] = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([]),
  }));
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

/**
 * Minimal mock transaction for reserveCharge / capture / release tests.
 * Supports: select().from().innerJoin().where().for().limit() → rows
 *           insert().values() → onConflictDoNothing
 *           update().set().where()
 */
class MockTransaction {
  private selectRows: unknown[] = [];

  addSelectRow(row: unknown) {
    this.selectRows.push(row);
  }

  select() {
    return this;
  }

  from() {
    return this;
  }

  innerJoin() {
    return this;
  }

  where() {
    return this;
  }

  for() {
    return this;
  }

  limit() {
    return this;
  }

  insert() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { values: (_v: any) => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }) };
  }

  update() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (_v: any) => ({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }

  get then() {
    // Makes the select chain await-able to return the queued rows.
    const rows = [...this.selectRows];
    this.selectRows = [];
    return Promise.resolve(rows).then.bind(Promise.resolve(rows));
  }
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
  it('returns hard_limited when balance is positive but hardCap is 0 (exact boundary — block at $0.00)', () => {
    // hardCap = $0.00 → netOutOfPocket (0) >= 0 → hard_limited
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: 20_000_000 }));
    expect(status).toBe('hard_limited');
  });

  it('returns hard_limited when balance is exactly 0 and hardCap is 0 (exact boundary)', () => {
    // User spent exactly their included credit + top-ups → balance = 0
    // With hardCap 0, netOutOfPocket (0) >= 0 → hard_limited
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: 0 }));
    expect(status).toBe('hard_limited');
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

  it('returns hard_limited when netOutOfPocket equals a non-zero hardCap (exact boundary)', () => {
    // hardCap = $5.00, balance = -$5.00 → netOutOfPocket = $5.00 >= $5.00 → hard_limited
    const status = computeSpendStatus(makePeriod({
      balanceMicrousd: -50_000,
      softCapMicrousd: null,
      hardCapMicrousd: 50_000,
    }));
    expect(status).toBe('hard_limited');
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

  it('top-up alone does not unblock when hardCap is 0 (exact boundary)', () => {
    // hardCap = $0.00 means block at $0.00.  Even after topping up,
    // netOutOfPocket = 0 >= 0 → hard_limited.  User must raise the cap
    // above 0 to unblock.
    const before = computeSpendStatus(makePeriod({ balanceMicrousd: -10_000 }));
    expect(before).toBe('hard_limited');

    // After $5 top-up (adds 50,000 microusd): balance = $4.00 → still blocked
    const after = computeSpendStatus(makePeriod({ balanceMicrousd: 40_000 }));
    expect(after).toBe('hard_limited');
  });

  it('top-up that partially restores balance but still negative keeps hard-limited', () => {
    // Before top-up: balance = -$10.00 → hard_limited
    // After $5 top-up: balance = -$5.00 → still negative → still hard_limited
    const status = computeSpendStatus(makePeriod({ balanceMicrousd: -50_000 }));
    expect(status).toBe('hard_limited');
  });
});

// ── getOrCreateOpenPeriod plan-change reconciliation tests ────────────────────

describe('getOrCreateOpenPeriod plan-change reconciliation', () => {
  type BillingPeriodRow = Awaited<ReturnType<UsageBillingRepository['getOrCreateOpenPeriod']>>;

  function makeExistingPeriod(overrides: Partial<BillingPeriodRow> = {}): BillingPeriodRow {
    return {
      id: 'period_acc_test_2026-08',
      accountId: 'acc_test',
      planIdSnapshot: 'free',
      rateCardId: 'rc_default_v1',
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-31T23:59:59.999Z'),
      includedCreditMicrousd: 0,
      softCapMicrousd: 0,
      hardCapMicrousd: 0,
      usageChargeMicrousd: 0,
      creditAppliedMicrousd: 0,
      reservedMicrousd: 0,
      balanceMicrousd: 0,
      status: 'open',
      externalInvoiceId: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  /**
   * Build a mock DB + tx where the SELECT returns `existing` (if provided),
   * and all UPDATE/INSERT calls are captured for assertions.
   */
  function makeDbWithPeriod(existing: BillingPeriodRow | null = null) {
    const ledgerInserts: Array<Record<string, unknown>> = [];
    const periodUpdates: Array<{ set: Record<string, unknown>; whereId: string }> = [];

    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue(makeSelectChain(existing ? [existing] : [])),
            }),
          }),
        }),
      }),
      update: vi.fn().mockImplementation((_table: unknown) => ({
        set: vi.fn().mockImplementation((setVals: Record<string, unknown>) => ({
          where: vi.fn().mockImplementation((_whereClause: unknown) => {
            periodUpdates.push({ set: setVals, whereId: 'captured' });
            const nextIncludedCredit = Number(setVals['includedCreditMicrousd'] ?? existing?.includedCreditMicrousd ?? 0);
            const nextBalance = existing
              ? existing.balanceMicrousd + (nextIncludedCredit - existing.includedCreditMicrousd)
              : nextIncludedCredit;
            return {
              returning: vi.fn().mockResolvedValue([
                {
                  ...existing,
                  includedCreditMicrousd: nextIncludedCredit,
                  balanceMicrousd: nextBalance,
                  softCapMicrousd: setVals['softCapMicrousd'] !== undefined ? setVals['softCapMicrousd'] : existing?.softCapMicrousd ?? null,
                  hardCapMicrousd: setVals['hardCapMicrousd'] !== undefined ? setVals['hardCapMicrousd'] : existing?.hardCapMicrousd ?? null,
                  updatedAt: new Date(),
                },
              ]),
            };
          }),
        })),
      })),
      insert: vi.fn().mockImplementation((_table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          ledgerInserts.push(vals as Record<string, unknown>);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(makeSelectChain([])),
            }),
          };
        }),
      })),
    };

    const db = {
      transaction: vi.fn().mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
      ),
    } as unknown as Database;

    return { db, tx, ledgerInserts, periodUpdates };
  }

  it('increases includedCreditMicrousd and balance when upgrading free → starter', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'free',
      includedCreditMicrousd: 0,
      balanceMicrousd: 0,
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'starter',
      'rc_default_v1',
      20_000_000, // $20.00 included credit for starter
      null,
      null,
    );

    // Returned object has updated credit and balance, but planIdSnapshot stays frozen
    expect(result.includedCreditMicrousd).toBe(20_000_000);
    expect(result.balanceMicrousd).toBe(20_000_000); // 0 + 20_000_000
    expect(result.planIdSnapshot).toBe('free'); // frozen — snapshot of the plan at period-open

    // Two UPDATEs issued: period (credit + balance) then account (spend status)
    expect(periodUpdates.length).toBe(2);
    // Period UPDATE only touches includedCreditMicrousd and balanceMicrousd
    expect(periodUpdates[0]!.set['planIdSnapshot']).toBeUndefined();
    expect(periodUpdates[0]!.set['includedCreditMicrousd']).toBe(20_000_000);
    // Account status recomputed after balance increase
    expect(periodUpdates[1]!.set['status']).toBe('active');

    // Ledger adjustment entry was inserted with unique sourceId per upgrade
    expect(ledgerInserts.length).toBe(1);
    const ledgerEntry = ledgerInserts[0]!;
    expect(ledgerEntry['entryType']).toBe('plan_change_adjustment');
    expect(ledgerEntry['direction']).toBe('credit');
    expect(ledgerEntry['amountMicrousd']).toBe(20_000_000);
    expect(ledgerEntry['sourceType']).toBe('plan_change');
    expect(ledgerEntry['sourceId']).toBe('period_acc_test_2026-08_starter_20000000');
  });

  it('does NOT decrease includedCreditMicrousd on downgrade starter → free', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 15_000_000, // $5 used
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'free',
      'rc_default_v1',
      0, // $0 included credit for free plan
      0, // caps unchanged (match existing period)
      0,
    );

    // Returned object preserves the higher included credit and original plan snapshot
    expect(result.includedCreditMicrousd).toBe(20_000_000);
    expect(result.balanceMicrousd).toBe(15_000_000); // unchanged
    expect(result.planIdSnapshot).toBe('starter'); // preserved — credit came from starter

    // No UPDATE, no INSERT — downgrade takes effect next period
    expect(periodUpdates.length).toBe(0);
    expect(ledgerInserts.length).toBe(0);
  });

  it('no-op when plan and included credit are unchanged', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 18_000_000,
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'starter',
      'rc_default_v1',
      20_000_000,
      0, // caps unchanged (match existing period)
      0,
    );

    // Unchanged
    expect(result.includedCreditMicrousd).toBe(20_000_000);
    expect(result.balanceMicrousd).toBe(18_000_000);
    expect(result.planIdSnapshot).toBe('starter');

    // No UPDATE, no INSERT
    expect(periodUpdates.length).toBe(0);
    expect(ledgerInserts.length).toBe(0);
  });

  it('no-op when plan changes but included credit is unchanged', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 20_000_000,
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'enterprise', // different plan, same credit amount
      'rc_default_v1',
      20_000_000,
      0, // caps unchanged (match existing period)
      0,
    );

    // Credit, balance, and planIdSnapshot unchanged — no-op
    expect(result.includedCreditMicrousd).toBe(20_000_000);
    expect(result.balanceMicrousd).toBe(20_000_000);
    expect(result.planIdSnapshot).toBe('starter');

    // No UPDATE, no INSERT
    expect(periodUpdates.length).toBe(0);
    expect(ledgerInserts.length).toBe(0);
  });

  it('multiple upgrades within a period accumulate included credit correctly', async () => {
    // First upgrade: free → starter (+$20)
    const existing1 = makeExistingPeriod({
      planIdSnapshot: 'free',
      includedCreditMicrousd: 0,
      balanceMicrousd: 0,
    });
    const { db: db1, ledgerInserts: ledger1 } = makeDbWithPeriod(existing1);
    const repo1 = new UsageBillingRepository(db1);
    const result1 = await repo1.getOrCreateOpenPeriod(
      'acc_test', new Date('2026-08-03T12:00:00.000Z'),
      'starter', 'rc_default_v1', 20_000_000, null, null,
    );
    expect(result1.includedCreditMicrousd).toBe(20_000_000);
    expect(result1.balanceMicrousd).toBe(20_000_000);
    expect(ledger1.length).toBe(1);
    expect(ledger1[0]!['sourceId']).toBe('period_acc_test_2026-08_starter_20000000');

    // Second upgrade: starter → enterprise (+$80, now total $100)
    const existing2 = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 20_000_000,
    });
    const { db: db2, ledgerInserts: ledger2 } = makeDbWithPeriod(existing2);
    const repo2 = new UsageBillingRepository(db2);
    const result2 = await repo2.getOrCreateOpenPeriod(
      'acc_test', new Date('2026-08-03T12:00:00.000Z'),
      'enterprise', 'rc_default_v1', 100_000_000, null, null,
    );
    expect(result2.includedCreditMicrousd).toBe(100_000_000);
    expect(result2.balanceMicrousd).toBe(100_000_000); // 20M + 80M
    expect(ledger2.length).toBe(1);
    const entry = ledger2[0]!;
    expect(entry['amountMicrousd']).toBe(80_000_000); // delta only
    expect(entry['sourceId']).toBe('period_acc_test_2026-08_enterprise_100000000'); // unique per upgrade
  });

  it('refreshes the open period caps to the upgraded plan caps on upgrade', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'free',
      includedCreditMicrousd: 0,
      balanceMicrousd: 0,
      softCapMicrousd: 0,
      hardCapMicrousd: 1_000_000, // free plan hard cap $1
    });
    const { db, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'starter',
      'rc_default_v1',
      20_000_000, // $20 included credit
      0, // starter soft cap $0
      2_000_000, // starter hard cap $2
    );

    // Period UPDATE now also refreshes the cap fields to the new plan's caps
    expect(periodUpdates.length).toBe(2);
    expect(periodUpdates[0]!.set['includedCreditMicrousd']).toBe(20_000_000);
    expect(periodUpdates[0]!.set['softCapMicrousd']).toBe(0);
    expect(periodUpdates[0]!.set['hardCapMicrousd']).toBe(2_000_000);
  });

  it('refreshes the open period caps even when included credit is unchanged', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 18_000_000,
      softCapMicrousd: 0,
      hardCapMicrousd: 1_000_000, // stale old cap
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'starter',
      'rc_default_v1',
      20_000_000, // same included credit
      0, // new soft cap
      2_000_000, // new hard cap $2
    );

    // Caps refreshed even though credit is unchanged
    expect(result.softCapMicrousd).toBe(0);
    expect(result.hardCapMicrousd).toBe(2_000_000);
    expect(result.includedCreditMicrousd).toBe(20_000_000);
    expect(result.balanceMicrousd).toBe(18_000_000); // unchanged — no credit delta

    // Period UPDATE + account status UPDATE; no ledger entry (cap-only refresh)
    expect(periodUpdates.length).toBe(2);
    expect(periodUpdates[0]!.set['includedCreditMicrousd']).toBeUndefined();
    expect(periodUpdates[0]!.set['softCapMicrousd']).toBe(0);
    expect(periodUpdates[0]!.set['hardCapMicrousd']).toBe(2_000_000);
    expect(ledgerInserts.length).toBe(0);
  });

  it('no-op when neither credit nor caps change', async () => {
    const existing = makeExistingPeriod({
      planIdSnapshot: 'starter',
      includedCreditMicrousd: 20_000_000,
      balanceMicrousd: 18_000_000,
      softCapMicrousd: 0,
      hardCapMicrousd: 2_000_000,
    });
    const { db, ledgerInserts, periodUpdates } = makeDbWithPeriod(existing);

    const repo = new UsageBillingRepository(db);
    const result = await repo.getOrCreateOpenPeriod(
      'acc_test',
      new Date('2026-08-03T12:00:00.000Z'),
      'starter',
      'rc_default_v1',
      20_000_000,
      0,
      2_000_000,
    );

    expect(result.hardCapMicrousd).toBe(2_000_000);
    // No UPDATE, no INSERT
    expect(periodUpdates.length).toBe(0);
    expect(ledgerInserts.length).toBe(0);
  });
});

// ── canSpendNow tests ────────────────────────────────────────────────────────

describe('canSpendNow', () => {
  it('returns canSpend: true when no open period exists (fresh user)', async () => {
    const db = {
      select: vi.fn().mockImplementation(() => makeSelectChain([])),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(0);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('active');
    expect(result.reason).toBe('ok');
  });

  it('returns canSpend: false, reason: hard_limited when account status is hard_limited', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'hard_limited',
          balanceMicrousd: 500,
          reservedMicrousd: 100,
          hardCapMicrousd: 5000,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(400);
    expect(result.hardCapMicrousd).toBe(5000);
    expect(result.status).toBe('hard_limited');
    expect(result.reason).toBe('hard_limited');
  });

  it('returns canSpend: false, reason: suspended when account status is suspended', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'suspended',
          balanceMicrousd: 500,
          reservedMicrousd: 100,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(400);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('suspended');
    expect(result.reason).toBe('suspended');
  });

  it('returns canSpend: true when available credit is positive, hardCap is null, and status is active (unlimited)', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: 100,
          reservedMicrousd: 100,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    // hardCap null → unlimited, even with zero available credit
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(0);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('active');
    expect(result.reason).toBe('ok');
  });

  it('returns canSpend: true when available credit is negative but hardCap is null (unlimited)', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -100,
          reservedMicrousd: 200,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    // hardCap null → unlimited, even deep negative
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(-300);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('active');
    expect(result.reason).toBe('ok');
  });

  it('returns canSpend: true, reason: ok when available credit is positive and status is active', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: 20_000_000,
          reservedMicrousd: 0,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(20_000_000);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('active');
    expect(result.reason).toBe('ok');
  });

  it('returns canSpend: true, reason: ok when available credit is positive and status is soft_limited', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'soft_limited',
          balanceMicrousd: 20_000_000,
          reservedMicrousd: 0,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(20_000_000);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('soft_limited');
    expect(result.reason).toBe('ok');
  });

  it('returns canSpend: true when soft_limited with zero available but no hard cap (unlimited — credit check only applies with cap)', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'soft_limited',
          balanceMicrousd: 100,
          reservedMicrousd: 100,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    // hardCap null → unlimited; soft_limited does not block
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(0);
    expect(result.hardCapMicrousd).toBeNull();
    expect(result.status).toBe('soft_limited');
    expect(result.reason).toBe('ok');
  });

  it('status check wins over credit check: hard_limited blocks even with positive available credit', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'hard_limited',
          balanceMicrousd: 20_000_000,
          reservedMicrousd: 0,
          hardCapMicrousd: null,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.reason).toBe('hard_limited');
  });

  // ── New hard-cap-aware tests ──────────────────────────────────────────

  it('blocks when available credit hits exact hard-cap boundary', async () => {
    // hardCap = $5.00 (50,000 microusd), available = -$5.00 → exactly at boundary
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -50_000,
          reservedMicrousd: 0,
          hardCapMicrousd: 50_000,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(-50_000);
    expect(result.hardCapMicrousd).toBe(50_000);
    expect(result.reason).toBe('no_available_credit');
  });

  it('blocks when available credit is beyond hard-cap boundary', async () => {
    // hardCap = $5.00, available = -$6.00 → beyond boundary
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -60_000,
          reservedMicrousd: 0,
          hardCapMicrousd: 50_000,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(-60_000);
    expect(result.reason).toBe('no_available_credit');
  });

  it('allows when balance is negative but still above hard-cap boundary', async () => {
    // hardCap = $5.00, available = -$3.00 → still above boundary (not yet reached)
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -30_000,
          reservedMicrousd: 0,
          hardCapMicrousd: 50_000,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(true);
    expect(result.availableMicrousd).toBe(-30_000);
    expect(result.reason).toBe('ok');
  });

  it('blocks at $0.00 when hardCap is 0 and available credit is 0', async () => {
    // hardCap = 0 → block at exactly $0.00
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: 0,
          reservedMicrousd: 0,
          hardCapMicrousd: 0,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(0);
    expect(result.hardCapMicrousd).toBe(0);
    expect(result.reason).toBe('no_available_credit');
  });

  it('blocks at $0.00 when hardCap is 0 and available credit is negative', async () => {
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -100,
          reservedMicrousd: 0,
          hardCapMicrousd: 0,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(-100);
    expect(result.reason).toBe('no_available_credit');
  });

  it('accounts for reservations: blocked when balance minus reserved hits boundary', async () => {
    // hardCap = $5.00, balance = -$4.00, reserved = $2.00 → available = -$6.00 → blocked
    const db = {
      select: vi.fn().mockImplementation(() =>
        makeSelectChain([{
          status: 'active',
          balanceMicrousd: -40_000,
          reservedMicrousd: 20_000,
          hardCapMicrousd: 50_000,
        }]),
      ),
    } as unknown as Database;

    const repo = new UsageBillingRepository(db);
    const result = await repo.canSpendNow('acc_test');
    expect(result.canSpend).toBe(false);
    expect(result.availableMicrousd).toBe(-60_000);
    expect(result.reason).toBe('no_available_credit');
  });
});

// ── reserveCharge tests ──────────────────────────────────────────────────────

describe('reserveCharge', () => {
  it('blocks reservation when post-reservation available credit hits exact hard-cap boundary', async () => {
    // hardCap = $5.00, available = -$3.00, reserve $2.00 → post-reservation = -$5.00 = boundary → blocked
    const tx = new MockTransaction();
    const db = {
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    tx.addSelectRow({
      status: 'active',
      balanceMicrousd: -30_000,
      reservedMicrousd: 0,
      hardCapMicrousd: 50_000,
    });

    const repo = new UsageBillingRepository(db);
    await expect(
      repo.reserveCharge({
        accountId: 'acc_test',
        periodId: 'period_1',
        amountMicrousd: 20_000,
        reservationId: 'resv_1',
      }),
    ).rejects.toThrow(/hardCap 50000/);
  });

  it('blocks reservation when post-reservation available credit goes beyond hard-cap boundary', async () => {
    // hardCap = $5.00, available = -$4.00, reserve $2.00 → post-reservation = -$6.00 > $5.00 → blocked
    const tx = new MockTransaction();
    const db = {
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    tx.addSelectRow({
      status: 'active',
      balanceMicrousd: -40_000,
      reservedMicrousd: 0,
      hardCapMicrousd: 50_000,
    });

    const repo = new UsageBillingRepository(db);
    await expect(
      repo.reserveCharge({
        accountId: 'acc_test',
        periodId: 'period_1',
        amountMicrousd: 20_000,
        reservationId: 'resv_2',
      }),
    ).rejects.toThrow(/hardCap 50000/);
  });

  it('allows reservation when post-reservation available credit stays above boundary', async () => {
    // hardCap = $5.00, available = -$2.00, reserve $1.00 → post-reservation = -$3.00 < $5.00 → allowed
    const tx = new MockTransaction();
    const db = {
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    tx.addSelectRow({
      status: 'active',
      balanceMicrousd: -20_000,
      reservedMicrousd: 0,
      hardCapMicrousd: 50_000,
    });

    const repo = new UsageBillingRepository(db);
    // Should not throw
    await expect(
      repo.reserveCharge({
        accountId: 'acc_test',
        periodId: 'period_1',
        amountMicrousd: 10_000,
        reservationId: 'resv_3',
      }),
    ).resolves.toBeDefined();
  });

  it('allows reservation when hardCap is null (unlimited)', async () => {
    // hardCap null → no credit-dimension blocking
    const tx = new MockTransaction();
    const db = {
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    tx.addSelectRow({
      status: 'active',
      balanceMicrousd: -100_000,
      reservedMicrousd: 0,
      hardCapMicrousd: null,
    });

    const repo = new UsageBillingRepository(db);
    await expect(
      repo.reserveCharge({
        accountId: 'acc_test',
        periodId: 'period_1',
        amountMicrousd: 200_000,
        reservationId: 'resv_4',
      }),
    ).resolves.toBeDefined();
  });

  it('blocks reservation at $0.00 when hardCap is 0 and post-reservation available is 0', async () => {
    const tx = new MockTransaction();
    const db = {
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as Database;

    tx.addSelectRow({
      status: 'active',
      balanceMicrousd: 0,
      reservedMicrousd: 0,
      hardCapMicrousd: 0,
    });

    const repo = new UsageBillingRepository(db);
    await expect(
      repo.reserveCharge({
        accountId: 'acc_test',
        periodId: 'period_1',
        amountMicrousd: 0,
        reservationId: 'resv_5',
      }),
    ).rejects.toThrow(/hardCap 0/);
  });
});
