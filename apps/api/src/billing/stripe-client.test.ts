import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { StripeClient, StripeSignatureError } from './stripe-client.js';
import type { StripeConfig } from '@herobids/domain';

function makeStripeConfig(overrides: Partial<StripeConfig> = {}): StripeConfig {
  return {
    secretKey: 'sk_test_xxx',
    webhookSecret: 'whsec_test_secret',
    planPrices: {},
    ...overrides,
  };
}

function signPayload(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedPayload = `${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

describe('StripeClient.verifyWebhookSignature', () => {
  const config = makeStripeConfig();
  const client = new StripeClient(config);

  it('verifies a valid signature', () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'customer.subscription.created', data: { object: {} }, created: Math.floor(Date.now() / 1000) });
    const sigHeader = signPayload(payload, config.webhookSecret);

    const event = client.verifyWebhookSignature(payload, sigHeader);
    expect(event.id).toBe('evt_test');
    expect(event.type).toBe('customer.subscription.created');
  });

  it('rejects an invalid signature', () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'test', data: { object: {} }, created: Math.floor(Date.now() / 1000) });
    const sigHeader = signPayload(payload, 'wrong_secret');

    expect(() => client.verifyWebhookSignature(payload, sigHeader)).toThrow(StripeSignatureError);
  });

  it('rejects a missing signature header format', () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'test', data: { object: {} }, created: Math.floor(Date.now() / 1000) });

    expect(() => client.verifyWebhookSignature(payload, 'invalid')).toThrow(StripeSignatureError);
  });

  it('rejects an expired timestamp', () => {
    const payload = JSON.stringify({ id: 'evt_test', type: 'test', data: { object: {} }, created: Math.floor(Date.now() / 1000) });
    // Sign with a timestamp from 10 minutes ago
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const signedPayload = `${oldTimestamp}.${payload}`;
    const sig = crypto.createHmac('sha256', config.webhookSecret).update(signedPayload, 'utf8').digest('hex');
    const sigHeader = `t=${oldTimestamp},v1=${sig}`;

    expect(() => client.verifyWebhookSignature(payload, sigHeader)).toThrow(StripeSignatureError);
  });
});

describe('StripeClient Managed Payments requests', () => {
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

  it('sends managed_payments[enabled] and the Stripe-Version header on checkout session creation', async () => {
    const fetchMock = stubFetch({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123', customer: 'cus_1', subscription: null, metadata: {} });
    const client = new StripeClient(makeStripeConfig());

    await client.createCheckoutSession({
      customerId: 'cus_1',
      priceId: 'price_123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      managedPayments: true,
      apiVersion: '2026-02-25.preview',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBe('2026-02-25.preview');
    const body = (init.body as string);
    expect(body).toContain('managed_payments%5Benabled%5D=true');
  });

  it('omits managed_payments[enabled] and the version header when not requested', async () => {
    const fetchMock = stubFetch({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123', customer: 'cus_1', subscription: null, metadata: {} });
    const client = new StripeClient(makeStripeConfig());

    await client.createCheckoutSession({
      customerId: 'cus_1',
      priceId: 'price_123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBeUndefined();
    expect(init.body as string).not.toContain('managed_payments');
  });

  it('creates a product with default_price_data and tax_code for Managed Payments provisioning', async () => {
    const fetchMock = stubFetch({ id: 'prod_123', name: 'Basic subscription', default_price: 'price_abc', tax_code: 'txcd_10103100' });
    const client = new StripeClient(makeStripeConfig());

    const product = await client.createProduct({
      name: 'Basic subscription',
      taxCode: 'txcd_10103100',
      defaultPriceData: { currency: 'usd', unitAmount: 1000, recurringInterval: 'month' },
      apiVersion: '2026-02-25.preview',
    });

    expect(product.default_price).toBe('price_abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/products');
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBe('2026-02-25.preview');
    const body = init.body as string;
    expect(body).toContain('tax_code=txcd_10103100');
    expect(body).toContain('default_price_data%5Bcurrency%5D=usd');
    expect(body).toContain('default_price_data%5Bunit_amount%5D=1000');
    expect(body).toContain('default_price_data%5Brecurring%5D%5Binterval%5D=month');
  });
});
