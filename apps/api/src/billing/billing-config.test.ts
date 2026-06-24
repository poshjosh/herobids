import { describe, it, expect } from 'vitest';
import { BillingConfigSchema, AppConfigSchema } from '@herobids/domain';

describe('BillingConfigSchema', () => {
  it('parses mock billing with defaults (local dev)', () => {
    const result = BillingConfigSchema.parse({});
    expect(result.stripe.secretKey).toBe('');
    expect(result.creem.apiKey).toBe('');
    expect(result.primaryProvider).toBe('mock');
  });

  it('parses enabled billing with Creem as primary', () => {
    const result = BillingConfigSchema.parse({
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
    expect(result.primaryProvider).toBe('creem');
    expect(result.creem.planProducts['pro']).toHaveLength(1);
  });

  it('parses enabled billing with Stripe as primary', () => {
    const result = BillingConfigSchema.parse({
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
    agentRuntime: {
      defaultBudgets: {
        maxHistoryMessages: 20,
        maxHistoryTokens: 40_000,
        maxRecentToolMessages: 6,
        maxToolResultChars: 4_000,
        maxVisibleToolSchemas: 64,
        maxContextBlockChars: 4_000,
      },
    },
  };

  it('rejects Stripe primary with no secretKey', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { primaryProvider: 'stripe', stripe: { webhookSecret: 'whsec_test' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Stripe primary with no webhookSecret', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { primaryProvider: 'stripe', stripe: { secretKey: 'sk_test_xxx' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Creem primary with no apiKey', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { primaryProvider: 'creem', creem: { webhookSecret: 'whsec_test' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Creem primary with no webhookSecret', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { primaryProvider: 'creem', creem: { apiKey: 'creem_test_xxx' } },
    });
    expect(result.success).toBe(false);
  });

  it('allows mock provider with no credentials', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { primaryProvider: 'mock' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects config that still carries the removed billing.enabled key', () => {
    const result = AppConfigSchema.safeParse({
      ...baseConfig,
      billing: { enabled: false },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('billing.enabled');
    }
  });
});
