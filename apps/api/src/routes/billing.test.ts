import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { BillingConfigSchema, PlansConfigSchema, UsageBillingConfigSchema } from '@herobids/domain';
import { UsageBillingRepository } from '@herobids/db';
import { PaymentProviderManager } from '../billing/provider-manager.js';
import { billingRoutes } from './billing.js';

describe('billing routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeChain(value: unknown[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'offset', 'innerJoin', 'leftJoin', 'groupBy']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (
      resolve: (v: unknown) => unknown,
      reject?: (v: unknown) => unknown,
    ) => Promise.resolve(value).then(resolve, reject);
    return chain;
  }

  function billingAccount(userId: string): NonNullable<Awaited<ReturnType<UsageBillingRepository['getAccountByUserId']>>> {
    return {
      id: `acc_${userId}`,
      userId,
      providerCustomerId: null,
      provider: null,
      activePlanId: 'free',
      status: 'active',
      creditBalanceMicrousd: 0,
      softCapMicrousd: null,
      hardCapMicrousd: null,
      periodAnchorDay: 1,
      timezone: 'UTC',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('GET /trading/fills returns 200 with empty records', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
    );

    const res = await app.inject({ method: 'GET', url: '/trading/fills' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records).toEqual([]);
  });

  it('usage routes return empty payloads when account is missing', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(null);

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
    );

    const summaryRes = await app.inject({ method: 'GET', url: '/billing/usage-summary' });
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json()).toEqual({ account: null, currentPeriod: null, warnings: [], byMeter: {} });

    const eventsRes = await app.inject({ method: 'GET', url: '/billing/usage-events' });
    expect(eventsRes.statusCode).toBe(200);
    expect(eventsRes.json()).toEqual({ records: [], total: 0, limit: 50, offset: 0 });

    const breakdownRes = await app.inject({ method: 'GET', url: '/billing/usage-breakdown' });
    expect(breakdownRes.statusCode).toBe(200);
    expect(breakdownRes.json()).toEqual({ byAgent: [], byMeter: [], bySkill: [] });

    const periodsRes = await app.inject({ method: 'GET', url: '/billing/periods' });
    expect(periodsRes.statusCode).toBe(200);
    expect(periodsRes.json()).toEqual({ periods: [] });
  });

  it('usage-events rejects invalid meter key and invalid date range filters', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(billingAccount('user-1'));

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
    );

    const invalidMeter = await app.inject({ method: 'GET', url: '/billing/usage-events?meterKey=bad_meter' });
    expect(invalidMeter.statusCode).toBe(400);
    expect(invalidMeter.json().error).toBe('billing.usage.invalid_meter_key');

    const invalidFrom = await app.inject({ method: 'GET', url: '/billing/usage-events?from=not-a-date' });
    expect(invalidFrom.statusCode).toBe(400);
    expect(invalidFrom.json().error).toBe('billing.usage.invalid_from');

    const invalidRange = await app.inject({ method: 'GET', url: '/billing/usage-events?from=2026-06-14T00:00:00.000Z&to=2026-06-13T00:00:00.000Z' });
    expect(invalidRange.statusCode).toBe(400);
    expect(invalidRange.json().error).toBe('billing.usage.invalid_range');
  });

  it('usage-events rejects period IDs not owned by current billing account', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const plansConfig = PlansConfigSchema.parse({});

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(billingAccount('user-1'));

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
    );

    const res = await app.inject({ method: 'GET', url: '/billing/usage-events?periodId=period_other_user' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('billing.usage.period_not_found');
  });

  it('usage-summary includes plan-driven top-up packs when enabled for plan and operator config', async () => {
    const billingConfig = BillingConfigSchema.parse({
      stripe: {
        secretKey: 'sk_test_xxx',
      },
    });
    const usageBillingConfig = UsageBillingConfigSchema.parse({
      enabled: true,
      creditTopUpsEnabled: true,
      topUpProductsByProvider: {
        stripe: [
          {
            packId: 'starter_500',
            externalId: 'price_starter_500',
            cents: 500,
          },
        ],
      },
    });
    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'pro',
      plans: {
        pro: {
          label: 'Pro',
          usage: {
            includedCreditCents: 0,
            topUpPackIds: ['starter_500'],
          },
        },
      },
    });

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue({
      ...billingAccount('user-1'),
      activePlanId: 'pro',
    });
    vi.spyOn(UsageBillingRepository.prototype, 'getUsageSummary').mockResolvedValue(null);
    vi.spyOn(UsageBillingRepository.prototype, 'getByMeterBreakdown').mockResolvedValue([]);

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
      usageBillingConfig,
    );

    const res = await app.inject({ method: 'GET', url: '/billing/usage-summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json().topUpPacks).toHaveLength(1);
    expect(res.json().topUpPacks).toEqual([
      {
        provider: 'stripe',
        packId: 'starter_500',
        cents: 500,
      },
    ]);
  });

  it('usage-summary omits top-up packs for providers that are not configured', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const usageBillingConfig = UsageBillingConfigSchema.parse({
      enabled: true,
      creditTopUpsEnabled: true,
      topUpProductsByProvider: {
        stripe: [
          {
            packId: 'starter_500',
            externalId: 'price_starter_500',
            cents: 500,
          },
        ],
      },
    });
    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'pro',
      plans: {
        pro: {
          usage: {
            includedCreditCents: 0,
            topUpPackIds: ['starter_500'],
          },
        },
      },
    });

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue({
      ...billingAccount('user-1'),
      activePlanId: 'pro',
    });
    vi.spyOn(UsageBillingRepository.prototype, 'getUsageSummary').mockResolvedValue(null);
    vi.spyOn(UsageBillingRepository.prototype, 'getByMeterBreakdown').mockResolvedValue([]);

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
      usageBillingConfig,
    );

    const res = await app.inject({ method: 'GET', url: '/billing/usage-summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json().topUpPacks).toEqual([]);
  });

  it('usage-summary warning thresholds follow net out-of-pocket spend rather than gross usage charge', async () => {
    const billingConfig = BillingConfigSchema.parse({});
    const usageBillingConfig = UsageBillingConfigSchema.parse({
      enabled: true,
      warningThresholdsPct: [50, 80, 100],
    });
    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'pro',
      plans: {
        pro: {
          usage: {
            includedCreditCents: 700,
            hardCapCents: 500,
          },
        },
      },
    });

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue({
      ...billingAccount('user-1'),
      activePlanId: 'pro',
    });
    vi.spyOn(UsageBillingRepository.prototype, 'getUsageSummary').mockResolvedValue({
      account: { ...billingAccount('user-1'), activePlanId: 'pro' },
      period: {
        id: 'period_1',
        accountId: 'acc_user-1',
        planIdSnapshot: 'pro',
        rateCardId: 'rc_default_v1',
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T23:59:59.999Z'),
        includedCreditMicrousd: 7_000_000,
        softCapMicrousd: null,
        hardCapMicrousd: 5_000_000,
        usageChargeMicrousd: 6_000_000,
        creditAppliedMicrousd: 6_000_000,
        reservedMicrousd: 0,
        balanceMicrousd: 1_000_000,
        status: 'open',
        externalInvoiceId: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    vi.spyOn(UsageBillingRepository.prototype, 'getByMeterBreakdown').mockResolvedValue([]);

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
      usageBillingConfig,
    );

    const res = await app.inject({ method: 'GET', url: '/billing/usage-summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual([
      { thresholdPct: 50, reached: false },
      { thresholdPct: 80, reached: false },
      { thresholdPct: 100, reached: false },
    ]);
  });

  it('top-up checkout routes through the matched provider-specific checkout path', async () => {
    const billingConfig = BillingConfigSchema.parse({
      primaryProvider: 'mock',
      creem: {
        apiKey: 'creem_test_xxx',
        webhookSecret: 'whsec_creem',
      },
    });
    const usageBillingConfig = UsageBillingConfigSchema.parse({
      enabled: true,
      creditTopUpsEnabled: true,
      topUpProductsByProvider: {
        creem: [
          {
            packId: 'starter_500',
            externalId: 'creem_pack_starter_500',
            cents: 500,
          },
        ],
      },
    });
    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'pro',
      plans: {
        pro: {
          usage: {
            topUpPackIds: ['starter_500'],
          },
        },
      },
    });

    const db = {
      select: vi.fn().mockImplementation(() => makeChain([{ email: 'user-1@example.com', displayName: 'User One' }])),
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue({
      ...billingAccount('user-1'),
      activePlanId: 'pro',
    });

    const createCheckoutUrlViaProviderSpy = vi.spyOn(PaymentProviderManager.prototype, 'createCheckoutUrlViaProvider')
      .mockResolvedValue({ url: 'https://checkout.example/top-up', provider: 'creem' });
    const createCheckoutUrlSpy = vi.spyOn(PaymentProviderManager.prototype, 'createCheckoutUrl')
      .mockResolvedValue({ url: 'https://checkout.example/wrong-path', provider: 'mock' });

    const app = Fastify();
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'user-1';
    });
    await billingRoutes(
      app,
      billingConfig,
      plansConfig,
      db as unknown as import('@herobids/db').Database,
      'http://localhost:5173',
      usageBillingConfig,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/billing/top-up-checkout-session',
      payload: { packId: 'starter_500' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCheckoutUrlViaProviderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        priceId: 'creem_pack_starter_500',
      }),
      'creem',
    );
    expect(createCheckoutUrlSpy).not.toHaveBeenCalled();
  });
});
