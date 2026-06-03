import { describe, it, expect } from 'vitest';
import { BillingConfigSchema, AppConfigSchema } from '@herobids/domain';

describe('BillingConfigSchema', () => {
  it('parses disabled billing with defaults', () => {
    const result = BillingConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.stripe.secretKey).toBe('');
    expect(result.creem.apiKey).toBe('');
    expect(result.primaryProvider).toBe('creem');
  });

  it('parses enabled billing with Creem as primary', () => {
    const result = BillingConfigSchema.parse({
      enabled: true,
      primaryProvider: 'creem',
      checkoutSuccessUrl: 'https://app.example.com/billing?session=success',
      checkoutCancelUrl: 'https://app.example.com/billing?session=cancelled',
      creem: {
        apiKey: 'creem_test_xxx',
        webhookSecret: 'whsec_creem',
        planProducts: {
          pro: [{ creemProductId: 'prod_123', interval: 'month', displayLabel: 'Pro' }],
        },
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.primaryProvider).toBe('creem');
    expect(result.creem.planProducts['pro']).toHaveLength(1);
  });

  it('parses enabled billing with Stripe as primary', () => {
    const result = BillingConfigSchema.parse({
      enabled: true,
      primaryProvider: 'stripe',
      checkoutSuccessUrl: 'https://app.example.com/billing?session=success',
      checkoutCancelUrl: 'https://app.example.com/billing?session=cancelled',
      stripe: {
        secretKey: 'sk_test_xxx',
        webhookSecret: 'whsec_xxx',
        planPrices: {
          pro: [{ stripePriceId: 'price_123', interval: 'month', displayLabel: 'Pro' }],
        },
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.primaryProvider).toBe('stripe');
    expect(result.stripe.planPrices['pro']).toHaveLength(1);
  });

  it('rejects invalid checkout URL', () => {
    expect(() =>
      BillingConfigSchema.parse({
        checkoutSuccessUrl: 'not-a-url',
      }),
    ).toThrow();
  });

  it('rejects invalid plan price interval', () => {
    expect(() =>
      BillingConfigSchema.parse({
        stripe: {
          planPrices: {
            pro: [{ stripePriceId: 'price_123', interval: 'weekly', displayLabel: 'Pro' }],
          },
        },
      }),
    ).toThrow();
  });

  it('rejects invalid Creem product interval', () => {
    expect(() =>
      BillingConfigSchema.parse({
        creem: {
          planProducts: {
            pro: [{ creemProductId: 'prod_123', interval: 'weekly', displayLabel: 'Pro' }],
          },
        },
      }),
    ).toThrow();
  });
});

describe('AppConfigSchema billing cross-validation', () => {
  const baseConfig = {
    app: { port: 3000, logLevel: 'info' },
    database: { url: 'postgres://localhost:5432/test' },
    redis: { url: 'redis://localhost:6379' },
    execution: { defaultSlippageBps: 50, orderTimeoutMs: 30000, maxRetries: 3 },
    risk: { globalMaxDrawdownPct: 20, maxOpenPositions: 10, maxPositionSizePct: 25 },
  };

  it('rejects enabled billing with Stripe primary but no Stripe secretKey', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: true, primaryProvider: 'stripe', stripe: { webhookSecret: 'whsec_test' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled billing with Stripe primary but no Stripe webhookSecret', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: true, primaryProvider: 'stripe', stripe: { secretKey: 'sk_test_xxx' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled billing with Creem primary but no Creem apiKey', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: true, primaryProvider: 'creem', creem: { webhookSecret: 'whsec_test' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects enabled billing with Creem primary but no Creem webhookSecret', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: true, primaryProvider: 'creem', creem: { apiKey: 'creem_test_xxx' } },
    });
    expect(result.success).toBe(false);
  });

  it('allows disabled billing with no secrets', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: false },
    });
    expect(result.success).toBe(true);
  });
});
