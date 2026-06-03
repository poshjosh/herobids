import { describe, it, expect } from 'vitest';
import { resolvePlanIdFromPriceId, resolvePlanIdFromProductId } from './entitlement-sync.js';
import type { BillingConfig } from '@herobids/domain';

function makeBillingConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    enabled: true,
    primaryProvider: 'creem',
    checkoutSuccessUrl: 'http://localhost:5173/billing?session=success',
    checkoutCancelUrl: 'http://localhost:5173/billing?session=cancelled',
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
