import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPayload, NotificationRecipient } from '@herobids/domain';
import { WebPushChannel, type WebPushChannelOptions } from './web-push-channel.js';
import type { WebPushSendRequest, WebPushSender } from './web-push-sender.js';

const logCalls = vi.hoisted((): unknown[] => []);

vi.mock('../logger.js', () => {
  const record = (...args: unknown[]) => {
    logCalls.push(args);
  };
  return {
    createLogger: () => ({ info: record, warn: record, error: record, debug: record }),
  };
});

const ENDPOINT = 'https://push.example.test/send/SECRET-ENDPOINT-TOKEN';

const recipient: NotificationRecipient = {
  userId: 'user-1',
  subscriptionId: 'sub-1',
  endpoint: ENDPOINT,
  p256dh: 'P256DH-KEY',
  auth: 'AUTH-SECRET',
};

const payload: NotificationPayload = {
  agentId: 'agent-1',
  agentName: 'Research Bot',
  title: 'Research Bot',
  body: 'You have a new message',
  url: '/agents/agent-1',
  eventClass: 'agent.reply',
};

function makeSender(statusCode: number) {
  const send = vi.fn(async (_request: WebPushSendRequest) => ({ statusCode }));
  return { send };
}

function makeStore() {
  return {
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
  };
}

const options: WebPushChannelOptions = { ttlSeconds: 3600, urgency: 'high' };

describe('WebPushChannel', () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  it('marks success on a 201 response and returns the subscription id', async () => {
    const sender = makeSender(201);
    const store = makeStore();
    const channel = new WebPushChannel(sender, store, options);

    const result = await channel.notify(recipient, payload);

    expect(result).toEqual({ ok: true, data: { subscriptionId: 'sub-1' } });
    expect(store.markSucceeded).toHaveBeenCalledWith('sub-1');
    expect(store.revoke).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it.each([404, 410])('revokes the subscription on %i and returns notification.subscription_gone', async (statusCode) => {
    const store = makeStore();
    const channel = new WebPushChannel(makeSender(statusCode), store, options);

    const result = await channel.notify(recipient, payload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('notification.subscription_gone');
    expect(store.revoke).toHaveBeenCalledWith('sub-1');
    expect(store.markSucceeded).not.toHaveBeenCalled();
  });

  it('records a failure on a 500 and does not revoke', async () => {
    const store = makeStore();
    const channel = new WebPushChannel(makeSender(500), store, options);

    const result = await channel.notify(recipient, payload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('notification.provider_failed');
    expect(store.markFailed).toHaveBeenCalledWith('sub-1', 'notification.provider_failed.http_500');
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('records a failure on a 429 and does not revoke', async () => {
    const store = makeStore();
    const channel = new WebPushChannel(makeSender(429), store, options);

    const result = await channel.notify(recipient, payload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('notification.provider_failed');
    expect(store.markFailed).toHaveBeenCalledWith('sub-1', 'notification.provider_failed.http_429');
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('treats a transport error as a provider failure without revoking', async () => {
    const sender: WebPushSender = { send: vi.fn(async () => { throw new Error('socket hang up'); }) };
    const store = makeStore();
    const channel = new WebPushChannel(sender, store, options);

    const result = await channel.notify(recipient, payload);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('notification.provider_failed');
    expect(store.markFailed).toHaveBeenCalledWith('sub-1', 'notification.provider_failed.transport_error');
    expect(store.revoke).not.toHaveBeenCalled();
  });

  it('sends the fixed payload with the configured ttl and urgency', async () => {
    const sender = makeSender(201);
    const channel = new WebPushChannel(sender, makeStore(), options);

    await channel.notify(recipient, payload);

    const request = sender.send.mock.calls[0]?.[0];
    expect(request?.ttlSeconds).toBe(3600);
    expect(request?.urgency).toBe('high');
    expect(request?.endpoint).toBe(ENDPOINT);
    expect(request ? JSON.parse(request.payload) : undefined).toEqual(payload);
  });

  it('never writes the endpoint or the transport error message to a log', async () => {
    const channel = new WebPushChannel(makeSender(410), makeStore(), options);
    await channel.notify(recipient, payload);

    const urlError = new TypeError(`Invalid URL: ${ENDPOINT}`);
    const transport: WebPushSender = { send: vi.fn(async () => { throw urlError; }) };
    await new WebPushChannel(transport, makeStore(), options).notify(recipient, payload);

    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain('SECRET-ENDPOINT-TOKEN');
    expect(logged).not.toContain('P256DH-KEY');
    expect(logged).not.toContain('Invalid URL');
    expect(logged).toContain('TypeError');
  });

  it('keeps the delivery result when the outcome write fails', async () => {
    const store = makeStore();
    store.markSucceeded.mockRejectedValueOnce(new Error('db down'));
    const channel = new WebPushChannel(makeSender(201), store, options);

    const result = await channel.notify(recipient, payload);

    expect(result.ok).toBe(true);
  });
});
