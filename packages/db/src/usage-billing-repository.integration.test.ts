import crypto from 'node:crypto';
import type postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { UsageBillingRepository } from './usage-billing-repository.js';
import type { Database } from './index.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';
import {
  billingAccounts,
  billingLedgerEntries,
  billingPeriods,
  billingRateCards,
  users,
} from './schema/index.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('UsageBillingRepository plan-change reconciliation (integration)', () => {
  let clientA: ReturnType<typeof postgres>;
  let clientB: ReturnType<typeof postgres>;
  let dbA: TestDb;
  let dbB: TestDb;
  let repoA: UsageBillingRepository;
  let repoB: UsageBillingRepository;

  const userId = `user_${crypto.randomUUID().slice(0, 8)}`;
  const accountId = `acct_${crypto.randomUUID().slice(0, 8)}`;
  const rateCardId = `rc_${crypto.randomUUID().slice(0, 8)}`;
  const periodId = `period_${accountId}_2026-08`;
  const now = new Date('2026-08-03T12:00:00.000Z');

  beforeAll(async () => {
    const handleA = openTestDb();
    dbA = handleA.db;
    clientA = handleA.client;

    const handleB = openTestDb();
    dbB = handleB.db;
    clientB = handleB.client;

    repoA = new UsageBillingRepository(dbA as unknown as Database);
    repoB = new UsageBillingRepository(dbB as unknown as Database);

    await truncate(
      clientA,
      'billing_ledger_entries',
      'billing_periods',
      'billing_accounts',
      'billing_rate_cards',
      'users',
    );

    await dbA.insert(users).values({
      id: userId,
      displayName: 'Test User',
      username: `test_${userId}`,
      email: `${userId}@example.com`,
      planId: 'free',
    });

    await dbA.insert(billingRateCards).values({
      id: rateCardId,
      name: 'default',
      version: 1,
      currency: 'USD',
      status: 'active',
      effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    });

    await dbA.insert(billingAccounts).values({
      id: accountId,
      ownerUserId: userId,
      status: 'active',
      currency: 'USD',
      activePlanId: 'free',
      softCapMicrousd: null,
      hardCapMicrousd: null,
    });

    await dbA.insert(billingPeriods).values({
      id: periodId,
      accountId,
      planIdSnapshot: 'free',
      rateCardId,
      periodStart: new Date('2026-08-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-31T23:59:59.999Z'),
      includedCreditMicrousd: 0,
      softCapMicrousd: null,
      hardCapMicrousd: null,
      usageChargeMicrousd: 0,
      creditAppliedMicrousd: 0,
      reservedMicrousd: 0,
      balanceMicrousd: 0,
      status: 'open',
    });
  }, 30_000);

  afterAll(async () => {
    await clientB.end();
    await clientA.end();
  });

  it('does not double-apply upgrade credit when two callers reconcile the same open period concurrently', async () => {
    await Promise.all([
      repoA.getOrCreateOpenPeriod(accountId, now, 'starter', rateCardId, 20_000_000, null, null),
      repoB.getOrCreateOpenPeriod(accountId, now, 'starter', rateCardId, 20_000_000, null, null),
    ]);

    const [period] = await dbA
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.id, periodId))
      .limit(1);

    expect(period).toBeDefined();
    expect(period!.planIdSnapshot).toBe('free');
    expect(period!.includedCreditMicrousd).toBe(20_000_000);
    expect(period!.balanceMicrousd).toBe(20_000_000);

    const ledgerRows = await dbA
      .select()
      .from(billingLedgerEntries)
      .where(eq(billingLedgerEntries.periodId, periodId));

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.entryType).toBe('plan_change_adjustment');
    expect(ledgerRows[0]!.amountMicrousd).toBe(20_000_000);
  });
});