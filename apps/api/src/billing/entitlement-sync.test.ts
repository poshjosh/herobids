import { describe, it, expect, vi } from 'vitest';
import { resolvePlanIdFromPriceId, resolvePlanIdFromProductId, EntitlementSync } from './entitlement-sync.js';
import { PlansConfigSchema, type BillingConfig } from '@herobids/domain';
import type { BillingRepository, UsageBillingRepository } from '@herobids/db';
import type { NormalizedWebhookEvent } from './provider-port.js';

function makeBillingConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    enabled: true,
    primaryProvider: 'creem',
    stripe: {
      secretKey: 'sk_test_xxx',
      webhookSecret: 'whsec_xxx',
      planPrices: {
        pro: [
          { stripePriceId: 'price_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', amountCents: 2900 },
          { stripePriceId: 'price_pro_yearly', interval: 'year', displayLabel: 'Pro Yearly', amountCents: 29000 },
        ],
        team: [
          { stripePriceId: 'price_team_monthly', interval: 'month', displayLabel: 'Team Monthly', amountCents: 9900 },
        ],
      },
    },
    creem: {
      apiKey: 'creem_test_xxx',
      webhookSecret: 'whsec_creem',
      apiBaseUrl: 'https://test-api.creem.io/v1',
      planProducts: {
        pro: [
          { creemProductId: 'prod_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', amountCents: 2900 },
        ],
        team: [
          { creemProductId: 'prod_team_monthly', interval: 'month', displayLabel: 'Team Monthly', amountCents: 9900 },
        ],
      },
    },
    ...overrides,
  } as BillingConfig;
}

describe('resolvePlanIdFromPriceId', () => {
  const config = makeBillingConfig();

  it('resolves a known monthly price to plan ID', () => {
    expect(resolvePlanIdFromPriceId(config, 'price_pro_monthly')).toBe('pro');
  });

  it('resolves a known yearly price to plan ID', () => {
    expect(resolvePlanIdFromPriceId(config, 'price_pro_yearly')).toBe('pro');
  });

  it('resolves a team price to plan ID', () => {
    expect(resolvePlanIdFromPriceId(config, 'price_team_monthly')).toBe('team');
  });

  it('returns null for unknown price ID', () => {
    expect(resolvePlanIdFromPriceId(config, 'price_unknown')).toBeNull();
  });

  it('returns null for empty price ID', () => {
    expect(resolvePlanIdFromPriceId(config, '')).toBeNull();
  });
});

describe('resolvePlanIdFromProductId', () => {
  const config = makeBillingConfig();

  it('resolves a known Creem product to plan ID', () => {
    expect(resolvePlanIdFromProductId(config, 'prod_pro_monthly')).toBe('pro');
  });

  it('resolves a team product to plan ID', () => {
    expect(resolvePlanIdFromProductId(config, 'prod_team_monthly')).toBe('team');
  });

  it('returns null for unknown product ID', () => {
    expect(resolvePlanIdFromProductId(config, 'prod_unknown')).toBeNull();
  });

  it('returns null for empty product ID', () => {
    expect(resolvePlanIdFromProductId(config, '')).toBeNull();
  });
});

describe('EntitlementSync top-up events', () => {
  function makeTopUpEvent(overrides: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
    return {
      id: 'evt_topup_1',
      type: 'top_up.completed',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_1',
      status: 'succeeded',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {
        referenceId: 'user-1',
        topUpCents: '500',
        topUpPackId: 'starter_500',
      },
      createdAt: new Date('2026-06-13T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('credits usage account and records event as processed', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null),
      getUserPlanId: vi.fn().mockResolvedValue('pro'),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: null,
        hardCapMicrousd: null,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      openTopUpCreditFromWebhook: vi.fn().mockResolvedValue(undefined),
      recomputeSpendState: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageBillingRepository;

    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'free',
      plans: {
        pro: {
          usage: {
            includedCreditCents: 250,
            softCapCents: 300,
            hardCapCents: 500,
          },
        },
      },
    });

    const sync = new EntitlementSync(billingRepo, makeBillingConfig(), 'free', usageBillingRepo, 'default', plansConfig);
    const result = await sync.processEvent(makeTopUpEvent());

    expect(result).toEqual({ processed: true });
    expect(usageBillingRepo.ensureActiveRateCard).toHaveBeenCalledWith('default');
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'pro', {
      softCapMicrousd: 3_000_000,
      hardCapMicrousd: 5_000_000,
    });
    expect(usageBillingRepo.getOrCreateOpenPeriod).toHaveBeenCalledWith(
      'acc_user_1',
      expect.any(Date),
      'pro',
      'rc_default_v1',
      2_500_000,
      3_000_000,
      5_000_000,
    );
    expect(usageBillingRepo.openTopUpCreditFromWebhook).toHaveBeenCalledWith({
      accountId: 'acc_user_1',
      periodId: 'period_1',
      amountMicrousd: 5_000_000,
      sourceId: 'stripe:evt_topup_1',
      description: 'Credit top-up (starter_500)',
    });
    expect(billingRepo.recordEventProcessed).toHaveBeenCalledWith('stripe:evt_topup_1', 'stripe.top_up.completed');
  });

  it('records failed event when top-up metadata is invalid', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn(),
      getUserPlanId: vi.fn(),
      getOrCreateBillingAccountForUser: vi.fn(),
      ensureActiveRateCard: vi.fn(),
      getOrCreateOpenPeriod: vi.fn(),
      openTopUpCreditFromWebhook: vi.fn(),
      recomputeSpendState: vi.fn(),
    } as unknown as UsageBillingRepository;

    const sync = new EntitlementSync(billingRepo, makeBillingConfig(), 'free', usageBillingRepo, 'default');
    const result = await sync.processEvent(makeTopUpEvent({ metadata: { referenceId: 'user-1', topUpCents: 'NaN' } }));

    expect(result.processed).toBe(false);
    expect(result.error).toContain('Invalid top-up webhook metadata');
    expect(billingRepo.recordEventFailed).toHaveBeenCalledTimes(1);
  });

  it('ensures usage billing account exists on active subscription webhook without overwriting caps', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: null,
        hardCapMicrousd: null,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      recomputeSpendState: vi.fn().mockResolvedValue('active'),
    } as unknown as UsageBillingRepository;

    const config = makeBillingConfig();
    const sync = new EntitlementSync(billingRepo, config, 'free', usageBillingRepo, 'default');

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_1',
      type: 'subscription.created',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'active',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-31T23:59:59.999Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    expect(billingRepo.upsertSubscriptionAndSyncPlan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', planId: 'pro' }),
      'pro',
    );
    // No existing account → plan caps are applied (pro plan has no usage caps in this config, so null)
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'pro', {
      softCapMicrousd: null,
      hardCapMicrousd: null,
    });
    expect(billingRepo.recordEventProcessed).toHaveBeenCalledWith('stripe:evt_sub_1', 'stripe.subscription.created');
  });

  it('ensures usage billing account exists on subscription cancel/downgrade without overwriting caps', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'free',
        softCapMicrousd: null,
        hardCapMicrousd: null,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      recomputeSpendState: vi.fn().mockResolvedValue('active'),
    } as unknown as UsageBillingRepository;

    const config = makeBillingConfig();
    const sync = new EntitlementSync(billingRepo, config, 'free', usageBillingRepo, 'default');

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_cancel',
      type: 'subscription.canceled',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'canceled',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: new Date('2026-07-07T00:00:00.000Z'),
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-07T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    expect(billingRepo.upsertSubscriptionAndSyncPlan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', planId: 'free' }),
      'free',
    );
    // Account is still ensured to exist (for top-up packs / spend controls)
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'free', {
      softCapMicrousd: null,
      hardCapMicrousd: null,
    });
    expect(billingRepo.recordEventProcessed).toHaveBeenCalledWith('stripe:evt_sub_cancel', 'stripe.subscription.canceled');
  });

  it('preserves existing user-set spend caps when billing account already exists on subscription webhook', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: 1_000_000,
        hardCapMicrousd: 2_000_000,
      }),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: 1_000_000,
        hardCapMicrousd: 2_000_000,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      recomputeSpendState: vi.fn().mockResolvedValue('active'),
    } as unknown as UsageBillingRepository;

    const config = makeBillingConfig();
    const sync = new EntitlementSync(billingRepo, config, 'free', usageBillingRepo, 'default');

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_upgrade',
      type: 'subscription.updated',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'active',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-31T23:59:59.999Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-07T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    // User-set caps (1M / 2M) are preserved — plan caps are NOT passed because the account already has caps
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'pro', {
      softCapMicrousd: undefined,
      hardCapMicrousd: undefined,
    });
    // The open period is reconciled with the account's (user-set) caps preserved
    expect(usageBillingRepo.getOrCreateOpenPeriod).toHaveBeenCalledWith(
      'acc_user_1',
      expect.any(Date),
      'pro',
      'rc_default_v1',
      0, // pro plan has no included credit in makeBillingConfig's plansConfig (not passed)
      1_000_000,
      2_000_000,
    );
    expect(usageBillingRepo.recomputeSpendState).toHaveBeenCalledWith('acc_user_1');
  });

  it('reconciles the open period with the upgraded plan included credit and caps', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      getAccountByUserId: vi.fn().mockResolvedValue(null),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: 3_000_000,
        hardCapMicrousd: 5_000_000,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      recomputeSpendState: vi.fn().mockResolvedValue('active'),
    } as unknown as UsageBillingRepository;

    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'free',
      plans: {
        pro: {
          usage: {
            includedCreditCents: 250,
            softCapCents: 300,
            hardCapCents: 500,
          },
        },
      },
    });

    const config = makeBillingConfig();
    const sync = new EntitlementSync(billingRepo, config, 'free', usageBillingRepo, 'default', plansConfig);

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_upgrade',
      type: 'subscription.updated',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'active',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-31T23:59:59.999Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-07T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    // No existing account → plan caps are applied to the account
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'pro', {
      softCapMicrousd: 3_000_000, // 300 cents * 10_000
      hardCapMicrousd: 5_000_000, // 500 cents * 10_000
    });
    // The open period is reconciled with the upgraded plan's included credit and caps
    expect(usageBillingRepo.getOrCreateOpenPeriod).toHaveBeenCalledWith(
      'acc_user_1',
      expect.any(Date),
      'pro',
      'rc_default_v1',
      2_500_000, // 250 cents * 10_000
      3_000_000, // 300 cents * 10_000
      5_000_000, // 500 cents * 10_000
    );
    expect(usageBillingRepo.recomputeSpendState).toHaveBeenCalledWith('acc_user_1');
  });

  it('refreshes stale plan-derived caps to the upgraded plan caps on subscription upgrade', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const usageBillingRepo = {
      // Existing account on the OLD plan (free) with plan-derived caps (soft $0, hard $1)
      getAccountByUserId: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'free',
        softCapMicrousd: 0,
        hardCapMicrousd: 1_000_000,
      }),
      getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
        id: 'acc_user_1',
        activePlanId: 'pro',
        softCapMicrousd: 3_000_000,
        hardCapMicrousd: 5_000_000,
      }),
      ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc_default_v1' }),
      getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period_1' }),
      recomputeSpendState: vi.fn().mockResolvedValue('active'),
    } as unknown as UsageBillingRepository;

    const plansConfig = PlansConfigSchema.parse({
      defaultPlanId: 'free',
      plans: {
        free: {
          usage: {
            includedCreditCents: 0,
            softCapCents: 0,
            hardCapCents: 100, // $1
          },
        },
        pro: {
          usage: {
            includedCreditCents: 250,
            softCapCents: 300,
            hardCapCents: 500, // $5
          },
        },
      },
    });

    const config = makeBillingConfig();
    const sync = new EntitlementSync(billingRepo, config, 'free', usageBillingRepo, 'default', plansConfig);

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_upgrade',
      type: 'subscription.updated',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'active',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-31T23:59:59.999Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-07T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    // Old plan-derived caps (free: 0 / $1) match the old plan config → refreshed to pro caps
    expect(usageBillingRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith('user-1', 'pro', {
      softCapMicrousd: 3_000_000, // 300 cents * 10_000
      hardCapMicrousd: 5_000_000, // 500 cents * 10_000
    });
    // The open period is reconciled with the upgraded plan's included credit and caps
    expect(usageBillingRepo.getOrCreateOpenPeriod).toHaveBeenCalledWith(
      'acc_user_1',
      expect.any(Date),
      'pro',
      'rc_default_v1',
      2_500_000, // 250 cents * 10_000
      3_000_000, // 300 cents * 10_000
      5_000_000, // 500 cents * 10_000
    );
    expect(usageBillingRepo.recomputeSpendState).toHaveBeenCalledWith('acc_user_1');
  });

  it('skips usage billing account creation when usageBillingRepo is not configured', async () => {
    const billingRepo = {
      isEventProcessed: vi.fn().mockResolvedValue(false),
      recordEventProcessed: vi.fn().mockResolvedValue(undefined),
      recordEventFailed: vi.fn().mockResolvedValue(undefined),
      findCustomerByExternalId: vi.fn().mockResolvedValue({ userId: 'user-1', externalCustomerId: 'cus_1', provider: 'stripe' }),
      findSubscriptionByExternalId: vi.fn().mockResolvedValue(null),
      upsertSubscriptionAndSyncPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as BillingRepository;

    const config = makeBillingConfig();
    // No usageBillingRepo passed — simulates billing-only deployment
    const sync = new EntitlementSync(billingRepo, config, 'free');

    const event: NormalizedWebhookEvent = {
      id: 'evt_sub_1',
      type: 'subscription.created',
      provider: 'stripe',
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'price_pro_monthly',
      status: 'active',
      currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-07-31T23:59:59.999Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    const result = await sync.processEvent(event);

    expect(result).toEqual({ processed: true });
    expect(billingRepo.upsertSubscriptionAndSyncPlan).toHaveBeenCalled();
    expect(billingRepo.recordEventProcessed).toHaveBeenCalledWith('stripe:evt_sub_1', 'stripe.subscription.created');
  });
});
