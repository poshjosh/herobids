import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { err, NOTIFICATION_ERROR_CODES, ok, AuthConfigSchema, type DomainError, type Result } from '@herobids/domain';
import type { Database, PushSubscriptionRecord, UpsertPushSubscriptionInput } from '@herobids/db';
import { authPlugin } from '../plugins/auth.js';
import {
  isAllowedPushEndpoint,
  pushRoutes,
  resolvePushPublicConfig,
  type PushPublicConfig,
  type PushRouteOptions,
} from './push.js';

const TEST_USER_ID = 'user-1';
const ENABLED: PushPublicConfig = { enabled: true, vapidPublicKey: 'BPublicVapidKeyForTests' };
const DISABLED: PushPublicConfig = { enabled: false, vapidPublicKey: null };
const VALID_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';
const VALID_BODY = {
  endpoint: VALID_ENDPOINT,
  expirationTime: null,
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};

function recordFor(input: UpsertPushSubscriptionInput): PushSubscriptionRecord {
  return {
    id: 'ps-1',
    userId: input.userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent,
    createdAt: new Date('2026-10-24T10:00:00.000Z'),
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    revokedAt: null,
  };
}

function fakeStore() {
  return {
    upsertForUser: vi.fn(async (input: UpsertPushSubscriptionInput): Promise<Result<PushSubscriptionRecord, DomainError>> => ok(recordFor(input))),
    revokeForUser: vi.fn(async (_userId: string, _id: string): Promise<boolean> => true),
  };
}

async function buildApp(options: PushRouteOptions, userId = TEST_USER_ID) {
  const app = Fastify();
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (request) => {
    request.userId = userId;
  });
  await pushRoutes(app, options);
  return app;
}

describe('resolvePushPublicConfig', () => {
  const complete = {
    enabled: true,
    webPush: { enabled: true, vapidSubject: 'mailto:ops@example.test', vapidPublicKey: 'BPublic' },
  };

  it('is off with the default configuration and hides the public key', () => {
    const config = {
      enabled: false,
      webPush: { enabled: false, vapidSubject: '', vapidPublicKey: '' },
    };
    expect(resolvePushPublicConfig(config)).toEqual({ enabled: false, vapidPublicKey: null });
  });

  it('is off when the master switch or the Web Push switch is off', () => {
    expect(resolvePushPublicConfig({ ...complete, enabled: false }).enabled).toBe(false);
    expect(resolvePushPublicConfig({ ...complete, webPush: { ...complete.webPush, enabled: false } }).enabled).toBe(false);
  });

  it('is off when the subject or the public key is blank', () => {
    expect(resolvePushPublicConfig({ ...complete, webPush: { ...complete.webPush, vapidSubject: '  ' } }).enabled).toBe(false);
    expect(resolvePushPublicConfig({ ...complete, webPush: { ...complete.webPush, vapidPublicKey: '' } }).enabled).toBe(false);
  });

  it('returns only the public key when on', () => {
    expect(resolvePushPublicConfig(complete)).toEqual({ enabled: true, vapidPublicKey: 'BPublic' });
  });
});

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://par01p.push.apple.com/abc',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts an allowlisted push service %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://localhost/send/abc',
    'https://foo.localhost/send/abc',
    'https://10.0.0.5/send/abc',
    'https://[::1]/send/abc',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://fcm.googleapis.com./fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://push.apple.com.evil.example/abc',
    'https://evilpush.apple.com/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://push.example.test/send/abc',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });
});

describe('GET /push/config', () => {
  it('returns the disabled shape when the feature is off', async () => {
    const app = await buildApp({ store: fakeStore(), publicConfig: DISABLED });

    const res = await app.inject({ method: 'GET', url: '/push/config' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, vapidPublicKey: null });
  });

  it('returns the public key when the feature is on', async () => {
    const app = await buildApp({ store: fakeStore(), publicConfig: ENABLED });

    const res = await app.inject({ method: 'GET', url: '/push/config' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, vapidPublicKey: 'BPublicVapidKeyForTests' });
  });
});

describe('POST /push/subscriptions', () => {
  it('returns 503 and writes nothing when the feature is off', async () => {
    const store = fakeStore();
    const app = await buildApp({ store, publicConfig: DISABLED });

    const res = await app.inject({ method: 'POST', url: '/push/subscriptions', payload: VALID_BODY });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'notification.disabled' });
    expect(store.upsertForUser).not.toHaveBeenCalled();
  });

  it('stores the subscription for the caller and returns 201 without the endpoint or keys', async () => {
    const store = fakeStore();
    const app = await buildApp({ store, publicConfig: ENABLED });

    const res = await app.inject({
      method: 'POST',
      url: '/push/subscriptions',
      payload: VALID_BODY,
      headers: { 'user-agent': 'TestBrowser/1.0' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.subscription.id).toBe('ps-1');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(VALID_ENDPOINT);
    expect(serialized).not.toContain('p256dh-key');
    expect(serialized).not.toContain('auth-secret');
    expect(store.upsertForUser).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      endpoint: VALID_ENDPOINT,
      p256dh: 'p256dh-key',
      auth: 'auth-secret',
      userAgent: 'TestBrowser/1.0',
    });
  });

  it('returns 409 with a dot-string code when the endpoint belongs to another user', async () => {
    const store = fakeStore();
    store.upsertForUser.mockImplementationOnce(async (): Promise<Result<PushSubscriptionRecord, DomainError>> => err({
      code: NOTIFICATION_ERROR_CODES.endpointOwned,
      message: 'endpoint_owned',
    }));
    const app = await buildApp({ store, publicConfig: ENABLED });

    const res = await app.inject({ method: 'POST', url: '/push/subscriptions', payload: VALID_BODY });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'notification.endpoint_owned' });
    expect(res.body).not.toContain(VALID_ENDPOINT);
  });

  it('accepts a repeat subscribe from the same user', async () => {
    const store = fakeStore();
    const app = await buildApp({ store, publicConfig: ENABLED });

    const first = await app.inject({ method: 'POST', url: '/push/subscriptions', payload: VALID_BODY });
    const second = await app.inject({
      method: 'POST',
      url: '/push/subscriptions',
      payload: { ...VALID_BODY, keys: { p256dh: 'rotated-key', auth: 'rotated-auth' } },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(store.upsertForUser).toHaveBeenLastCalledWith(expect.objectContaining({ p256dh: 'rotated-key', auth: 'rotated-auth' }));
  });

  it.each<[string, object | undefined]>([
    ['a missing body', undefined],
    ['a missing auth key', { endpoint: VALID_ENDPOINT, keys: { p256dh: 'k' } }],
    ['an empty p256dh', { endpoint: VALID_ENDPOINT, keys: { p256dh: '', auth: 'a' } }],
    ['a whitespace-only auth', { endpoint: VALID_ENDPOINT, keys: { p256dh: 'k', auth: '   ' } }],
    ['an http endpoint', { endpoint: 'http://fcm.googleapis.com/send/abc', keys: { p256dh: 'k', auth: 'a' } }],
    ['a non-URL endpoint', { endpoint: 'push-me', keys: { p256dh: 'k', auth: 'a' } }],
    ['an IP-literal endpoint', { endpoint: 'https://127.0.0.1/send/abc', keys: { p256dh: 'k', auth: 'a' } }],
    ['a localhost endpoint', { endpoint: 'https://localhost/send/abc', keys: { p256dh: 'k', auth: 'a' } }],
    ['a cloud metadata endpoint', { endpoint: 'https://metadata.google.internal/computeMetadata/v1/', keys: { p256dh: 'k', auth: 'a' } }],
    ['a lookalike push host', { endpoint: 'https://fcm.googleapis.com.evil.example/send/abc', keys: { p256dh: 'k', auth: 'a' } }],
  ])('returns 400 for %s and writes nothing', async (_label, payload) => {
    const store = fakeStore();
    const app = await buildApp({ store, publicConfig: ENABLED });

    const res = await app.inject({ method: 'POST', url: '/push/subscriptions', payload });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.body).not.toContain('auth-secret');
    expect(store.upsertForUser).not.toHaveBeenCalled();
  });
});

describe('DELETE /push/subscriptions/:id', () => {
  it('revokes the caller row and returns 204', async () => {
    const store = fakeStore();
    const app = await buildApp({ store, publicConfig: ENABLED });

    const res = await app.inject({ method: 'DELETE', url: '/push/subscriptions/ps-1' });

    expect(res.statusCode).toBe(204);
    expect(store.revokeForUser).toHaveBeenCalledWith(TEST_USER_ID, 'ps-1');
  });

  it('returns 404 when the row is not the caller own', async () => {
    const store = fakeStore();
    store.revokeForUser.mockImplementationOnce(async () => false);
    const app = await buildApp({ store, publicConfig: ENABLED });

    const res = await app.inject({ method: 'DELETE', url: '/push/subscriptions/ps-other' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('push routes behind the auth plugin', () => {
  async function buildAuthenticatedApp() {
    const store = fakeStore();
    const app = Fastify();
    const config = AuthConfigSchema.parse({ jwtSecret: 'test-secret-that-is-long-enough-for-hs256' });
    await authPlugin(app, { config, db: {} as Database });
    await pushRoutes(app, { store, publicConfig: ENABLED });
    return { app, store };
  }

  it.each([
    ['POST', '/push/subscriptions'],
    ['GET', '/push/config'],
    ['DELETE', '/push/subscriptions/ps-1'],
  ] as const)('rejects %s %s without a token', async (method, url) => {
    const { app, store } = await buildAuthenticatedApp();

    const res = await app.inject({ method, url, payload: method === 'POST' ? VALID_BODY : undefined });

    expect(res.statusCode).toBe(401);
    expect(store.upsertForUser).not.toHaveBeenCalled();
    expect(store.revokeForUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed bearer token before any store call', async () => {
    const { app, store } = await buildAuthenticatedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/push/subscriptions',
      payload: VALID_BODY,
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(res.statusCode).toBe(401);
    expect(store.upsertForUser).not.toHaveBeenCalled();
  });
});
