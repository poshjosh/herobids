import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsageBillingRepository } from './usage-billing-repository.js';
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
