import { describe, it, expect } from 'vitest';
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
