import crypto from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StripeProvider } from './stripe-provider.js';
import { UnknownWebhookEventTypeError } from './provider-port.js';
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

describe('StripeProvider.verifyWebhook — checkout.session.completed normalization', () => {
  const config = makeStripeConfig();
  const provider = new StripeProvider(config, makeBillingRepo(null));

  function signStripePayload(payload: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  it('normalizes a top-up checkout.session.completed event into top_up.completed', () => {
    const payload = JSON.stringify({
      id: 'evt_stripe_topup_1',
      type: 'checkout.session.completed',
      created: 1700000000,
      data: {
        object: {
          id: 'cs_topup_1',
          mode: 'payment',
          customer: 'cus_topup_1',
          subscription: null,
          metadata: {
            checkoutKind: 'top_up',
            topUpPackId: 'Topup20',
            topUpCents: '2000',
            herobidsUserId: 'user-topup-1',
          },
        },
      },
    });
    const signature = signStripePayload(payload, config.webhookSecret);

    const event = provider.verifyWebhook(payload, { 'stripe-signature': signature });

    expect(event.type).toBe('top_up.completed');
    expect(event.status).toBe('paid');
    expect(event.customerId).toBe('cus_topup_1');
    expect(event.subscriptionId).toBe('');
    expect(event.productOrPriceId).toBe('Topup20');
    expect(event.metadata['checkoutKind']).toBe('top_up');
    expect(event.metadata['herobidsUserId']).toBe('user-topup-1');
  });

  it('throws UnknownWebhookEventTypeError with diagnostic details for a non-top-up checkout.session.completed event', () => {
    const payload = JSON.stringify({
      id: 'evt_stripe_sub_1',
      type: 'checkout.session.completed',
      created: 1700000000,
      data: {
        object: {
          id: 'cs_sub_1',
          mode: 'subscription',
          customer: 'cus_sub_1',
          subscription: 'sub_1',
          metadata: {
            displayName: 'Herobids',
            herobidsPlanId: 'starter',
            herobidsUserId: 'user-sub-1',
          },
        },
      },
    });
    const signature = signStripePayload(payload, config.webhookSecret);

    try {
      provider.verifyWebhook(payload, { 'stripe-signature': signature });
      expect.fail('expected verifyWebhook to throw UnknownWebhookEventTypeError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownWebhookEventTypeError);
      const typedErr = err as UnknownWebhookEventTypeError;
      expect(typedErr.eventType).toBe('checkout.session.completed');
      expect(typedErr.details?.['mode']).toBe('subscription');
      expect(typedErr.details?.['checkoutKind']).toBeUndefined();
      expect(typedErr.details?.['metadataKeys']).toEqual(['displayName', 'herobidsPlanId', 'herobidsUserId']);
    }
  });

  it('throws UnknownWebhookEventTypeError when checkoutKind metadata is missing entirely', () => {
    const payload = JSON.stringify({
      id: 'evt_stripe_missing_metadata',
      type: 'checkout.session.completed',
      created: 1700000000,
      data: {
        object: {
          id: 'cs_missing_1',
          mode: 'payment',
          customer: 'cus_missing_1',
          subscription: null,
        },
      },
    });
    const signature = signStripePayload(payload, config.webhookSecret);

    expect(() => provider.verifyWebhook(payload, { 'stripe-signature': signature })).toThrow(UnknownWebhookEventTypeError);
  });
});
