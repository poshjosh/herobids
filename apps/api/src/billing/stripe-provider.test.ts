import { describe, it, expect, vi, afterEach } from 'vitest';
import { StripeProvider } from './stripe-provider.js';
import type { BillingRepository, BillingCustomerRow } from '@herobids/db';
import type { StripeConfig } from '@herobids/domain';

function makeStripeConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_xxx',
    webhookSecret: 'whsec_test_secret',
    planPrices: {
      pro: [
        { stripePriceId: 'price_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', managedPayments: true },
        { stripePriceId: 'price_pro_yearly', interval: 'year', displayLabel: 'Pro Yearly', managedPayments: false },
      ],
    },
    managedPaymentsApiVersion: '2026-02-25.preview',
    ...overrides,
  };
}

function makeBillingRepo(customer: BillingCustomerRow | null): BillingRepository {
  return {
    findCustomerByUserIdAndProvider: vi.fn().mockResolvedValue(customer),
    getOrCreateCustomer: vi.fn().mockResolvedValue(customer),
  } as unknown as BillingRepository;
}

describe('StripeProvider.createCheckoutUrl — Managed Payments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(responseBody: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responseBody,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('enables managed_payments and pins the preview API version for a price configured with managedPayments: true', async () => {
    const existingCustomer: BillingCustomerRow = {
      id: 'bc_1',
      userId: 'user-1',
      provider: 'stripe',
      externalCustomerId: 'cus_1',
      createdAt: new Date(),
    };
    const fetchMock = stubFetch({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', customer: 'cus_1', subscription: null, metadata: {} });
    const provider = new StripeProvider(makeStripeConfig(), makeBillingRepo(existingCustomer));

    await provider.createCheckoutUrl({
      userId: 'user-1',
      email: 'user@example.com',
      planId: 'pro',
      priceId: 'price_pro_monthly',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBe('2026-02-25.preview');
    expect(init.body as string).toContain('managed_payments%5Benabled%5D=true');
  });

  it('does not enable managed_payments for a price not configured with managedPayments: true', async () => {
    const existingCustomer: BillingCustomerRow = {
      id: 'bc_1',
      userId: 'user-1',
      provider: 'stripe',
      externalCustomerId: 'cus_1',
      createdAt: new Date(),
    };
    const fetchMock = stubFetch({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', customer: 'cus_1', subscription: null, metadata: {} });
    const provider = new StripeProvider(makeStripeConfig(), makeBillingRepo(existingCustomer));

    await provider.createCheckoutUrl({
      userId: 'user-1',
      email: 'user@example.com',
      planId: 'pro',
      priceId: 'price_pro_yearly',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      metadata: {},
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBeUndefined();
    expect(init.body as string).not.toContain('managed_payments');
  });
});
