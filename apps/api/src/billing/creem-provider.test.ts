import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { CreemProvider, CreemSignatureError, CreemSubscriptionItemMismatchError } from './creem-provider.js';
import { UnknownWebhookEventTypeError } from './provider-port.js';
import type { CreemConfig } from '@herobids/domain';

function makeCreemConfig(overrides: Partial<CreemConfig> = {}): CreemConfig {
  return {
    apiKey: 'creem_test_xxx',
    webhookSecret: 'whsec_creem_test_secret',
    apiBaseUrl: 'https://test-api.creem.io/v1',
    planProducts: {
      pro: [{ creemProductId: 'prod_pro_monthly', interval: 'month', displayLabel: 'Pro Monthly', amountCents: 2900 }],
    },
    ...overrides,
  };
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('CreemProvider.verifyWebhook', () => {
  const config = makeCreemConfig();
  const provider = new CreemProvider(config);

  it('verifies a valid signature and normalizes event', () => {
    const payload = JSON.stringify({
      id: 'evt_creem_1',
      event_type: 'subscription.active',
      object: {
        id: 'sub_123',
        customer_id: 'cus_456',
        product_id: 'prod_pro_monthly',
        status: 'active',
        current_period_start_date: '2026-01-01T00:00:00Z',
        current_period_end_date: '2026-02-01T00:00:00Z',
        metadata: { referenceId: 'user_1' },
      },
      created_at: '2026-01-01T00:00:00Z',
    });

    const signature = signPayload(payload, config.webhookSecret);
    const event = provider.verifyWebhook(payload, { 'creem-signature': signature });

    expect(event.id).toBe('evt_creem_1');
    expect(event.type).toBe('subscription.created');
    expect(event.provider).toBe('creem');
    expect(event.subscriptionId).toBe('sub_123');
    expect(event.customerId).toBe('cus_456');
    expect(event.productOrPriceId).toBe('prod_pro_monthly');
    expect(event.cancelAtPeriodEnd).toBe(false);
  });

  it('rejects an invalid signature', () => {
    const payload = JSON.stringify({ id: 'evt_creem_2', event_type: 'subscription.active', object: {} });
    const badSig = signPayload(payload, 'wrong_secret');

    expect(() => provider.verifyWebhook(payload, { 'creem-signature': badSig })).toThrow(CreemSignatureError);
  });

  it('rejects a missing creem-signature header', () => {
    const payload = JSON.stringify({ id: 'evt_creem_3', event_type: 'subscription.active', object: {} });

    expect(() => provider.verifyWebhook(payload, {})).toThrow(CreemSignatureError);
  });

  it('normalizes subscription.canceled event type', () => {
    const payload = JSON.stringify({
      id: 'evt_creem_4',
      event_type: 'subscription.canceled',
      object: { id: 'sub_789', customer_id: 'cus_100', status: 'canceled' },
    });
    const signature = signPayload(payload, config.webhookSecret);
    const event = provider.verifyWebhook(payload, { 'creem-signature': signature });

    expect(event.type).toBe('subscription.canceled');
  });

  it('normalizes subscription.scheduled_cancel as update with cancelAtPeriodEnd', () => {
    const payload = JSON.stringify({
      id: 'evt_creem_5',
      event_type: 'subscription.scheduled_cancel',
      object: { id: 'sub_900', customer_id: 'cus_200', status: 'scheduled_cancel' },
    });
    const signature = signPayload(payload, config.webhookSecret);
    const event = provider.verifyWebhook(payload, { 'creem-signature': signature });

    expect(event.type).toBe('subscription.updated');
    expect(event.cancelAtPeriodEnd).toBe(true);
  });

  it('ignores non-top-up checkout.completed events', () => {
    const payload = JSON.stringify({
      id: 'evt_creem_6',
      event_type: 'checkout.completed',
      object: {
        id: 'chk_123',
        customer_id: 'cus_300',
        product_id: 'prod_pro_monthly',
        status: 'completed',
      },
    });
    const signature = signPayload(payload, config.webhookSecret);

    expect(() => provider.verifyWebhook(payload, { 'creem-signature': signature })).toThrow(UnknownWebhookEventTypeError);
  });

  it('normalizes top-up checkout.completed events', () => {
    const payload = JSON.stringify({
      id: 'evt_creem_7',
      event_type: 'checkout.completed',
      object: {
        id: 'chk_456',
        customer_id: 'cus_301',
        product_id: 'topup_20',
        status: 'completed',
        metadata: {
          checkoutKind: 'top_up',
          referenceId: 'user_301',
          topUpCents: '2000',
          topUpPackId: 'Topup20',
        },
      },
      created_at: '2026-01-01T00:00:00Z',
    });
    const signature = signPayload(payload, config.webhookSecret);
    const event = provider.verifyWebhook(payload, { 'creem-signature': signature });

    expect(event.type).toBe('top_up.completed');
    expect(event.status).toBe('paid');
    expect(event.subscriptionId).toBe('');
    expect(event.customerId).toBe('cus_301');
    expect(event.productOrPriceId).toBe('topup_20');
    expect(event.metadata['checkoutKind']).toBe('top_up');
  });
});

describe('CreemProvider.cancelSubscription', () => {
  const config = makeCreemConfig();
  const provider = new CreemProvider(config);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends mode=scheduled with onExecute=cancel for at-period-end cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.cancelSubscription('sub_123', true);

    expect(fetchMock).toHaveBeenCalledWith(
      `${config.apiBaseUrl}/subscriptions/sub_123/cancel`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'scheduled', onExecute: 'cancel' }) }),
    );
  });

  it('sends mode=immediate with no onExecute for immediate cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await provider.cancelSubscription('sub_123', false);

    expect(fetchMock).toHaveBeenCalledWith(
      `${config.apiBaseUrl}/subscriptions/sub_123/cancel`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ mode: 'immediate' }) }),
    );
  });
});

describe('CreemProvider.upgradeSubscription', () => {
  const config = makeCreemConfig();
  const provider = new CreemProvider(config);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchWithSubscription(items: Array<{ id?: string; product_id?: string; price_id?: string }>) {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { method: string }) => {
      if (init.method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fetches the subscription and updates the matched item by id (avoids appending a new item)', async () => {
    const fetchMock = stubFetchWithSubscription([{ id: 'sitem_1', product_id: 'prod_pro_monthly' }]);

    await provider.upgradeSubscription('sub_123', 'prod_pro_monthly', 'prod_pro_yearly', true);

    expect(fetchMock).toHaveBeenCalledWith(`${config.apiBaseUrl}/subscriptions?subscription_id=sub_123`, expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenCalledWith(
      `${config.apiBaseUrl}/subscriptions/sub_123`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ items: [{ id: 'sitem_1', product_id: 'prod_pro_yearly' }], update_behavior: 'proration-charge-immediately' }),
      }),
    );
  });

  it('uses proration-none when prorate is false', async () => {
    stubFetchWithSubscription([{ id: 'sitem_1', price_id: 'price_pro_monthly' }]);

    await provider.upgradeSubscription('sub_123', 'price_pro_monthly', 'prod_pro_yearly', false);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      `${config.apiBaseUrl}/subscriptions/sub_123`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ items: [{ id: 'sitem_1', product_id: 'prod_pro_yearly' }], update_behavior: 'proration-none' }),
      }),
    );
  });

  it('throws instead of updating when no item matches the current product/price id', async () => {
    stubFetchWithSubscription([{ id: 'sitem_1', product_id: 'prod_other' }]);

    await expect(
      provider.upgradeSubscription('sub_123', 'prod_pro_monthly', 'prod_pro_yearly', true),
    ).rejects.toThrow(CreemSubscriptionItemMismatchError);
  });

  it('throws instead of updating when the current product/price id matches multiple items', async () => {
    stubFetchWithSubscription([
      { id: 'sitem_1', product_id: 'prod_pro_monthly' },
      { id: 'sitem_2', product_id: 'prod_pro_monthly' },
    ]);

    await expect(
      provider.upgradeSubscription('sub_123', 'prod_pro_monthly', 'prod_pro_yearly', true),
    ).rejects.toThrow(CreemSubscriptionItemMismatchError);
  });

  it('throws instead of updating when the matched item has no id', async () => {
    stubFetchWithSubscription([{ product_id: 'prod_pro_monthly' }]);

    await expect(
      provider.upgradeSubscription('sub_123', 'prod_pro_monthly', 'prod_pro_yearly', true),
    ).rejects.toThrow(CreemSubscriptionItemMismatchError);
  });
});
