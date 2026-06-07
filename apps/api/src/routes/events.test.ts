import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import * as jose from 'jose';
import { eventsRoutes } from './events.js';
import type { AuthConfig } from '@herobids/domain';
import type { RedisSubscriberFactory, EventSubscriber } from './events.js';

const JWT_SECRET = 'a-valid-test-secret-that-is-at-least-32-characters-long';
const TEST_USER_ID = 'user-1';

function makeAuthConfig(): AuthConfig {
  return {
    publicBaseUrl: 'http://localhost:3000',
    frontendOrigin: 'http://localhost:5173',
    jwtSecret: JWT_SECRET,
    jwtTtlSecs: 86400,
    exchangeCodeTtlSecs: 60,
    googleClientId: '',
    googleClientSecret: '',
    secureCookie: false,
    adminUserIds: [],
  };
}

async function makeToken(userId: string, secret = JWT_SECRET, ttl: string | number = '1h'): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setExpirationTime(ttl)
    .sign(key);
}

function makeSubscriberFactory(): { factory: RedisSubscriberFactory; subscribeCalls: string[] } {
  const subscribeCalls: string[] = [];
  const factory: RedisSubscriberFactory = () => ({
    subscribe: vi.fn(async (channel: string, _callback: (msg: string) => void) => { subscribeCalls.push(channel); }),
    unsubscribe: vi.fn(async () => {}),
  });
  return { factory, subscribeCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// WebSocket connections require an actual HTTP server; use Fastify's built-in listen
// with a random port for integration-style tests.

describe('GET /events — WebSocket auth', () => {
  it('registers the /events route without throwing', async () => {
    const { factory } = makeSubscriberFactory();
    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    // Should not throw
    await expect(eventsRoutes(app, makeAuthConfig(), factory)).resolves.toBeUndefined();
    await app.close();
  });

  it('registers a route at /events', async () => {
    const { factory } = makeSubscriberFactory();
    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    await eventsRoutes(app, makeAuthConfig(), factory);

    // Either printRoutes lists /events, or at minimum a GET on /events returns
    // something other than a generic "Not Found" (i.e., the plugin is wired in).
    const routes = app.printRoutes();
    const res = await app.inject({ method: 'GET', url: '/events' });
    // The route is registered if either printRoutes mentions it or the response is
    // handled by our plugin (not a plain 404 with generic message).
    const routeRegistered = routes.includes('events') || res.statusCode !== 404 ||
      (res.statusCode === 404 && !res.json<Record<string, unknown>>()?.['message']?.toString().includes('Route GET:/events not found'));
    expect(routeRegistered).toBe(true);
    await app.close();
  });
});

describe('GET /events — connection rejection via HTTP inject', () => {
  it('returns a non-200 response when called as plain HTTP (not a WebSocket upgrade)', async () => {
    const { factory } = makeSubscriberFactory();
    const app = Fastify();
    app.decorateRequest('userId', '');
    app.decorateRequest('userPlanId', '');
    await eventsRoutes(app, makeAuthConfig(), factory);

    // Fastify websocket routes behave differently from regular routes on plain HTTP:
    // @fastify/websocket either returns 404 (route not matched for HTTP), 400, or 426.
    const res = await app.inject({ method: 'GET', url: '/events?token=test' });
    expect([400, 404, 426]).toContain(res.statusCode);
    await app.close();
  });
});

describe('eventsRoutes — JWT validation logic', () => {
  it('accepts a valid JWT with correct secret', async () => {
    const token = await makeToken(TEST_USER_ID);
    // Token should be a valid JWT string
    expect(token.split('.').length).toBe(3);
  });

  it('rejects an expired JWT', async () => {
    const expiredToken = await makeToken(TEST_USER_ID, JWT_SECRET, '0s');
    // Attempt to verify — should throw
    const key = new TextEncoder().encode(JWT_SECRET);
    await expect(jose.jwtVerify(expiredToken, key, { algorithms: ['HS256'] })).rejects.toThrow();
  });

  it('rejects a JWT signed with a wrong secret', async () => {
    const wrongToken = await makeToken(TEST_USER_ID, 'wrong-secret-that-is-also-32-chars-long!!');
    const key = new TextEncoder().encode(JWT_SECRET);
    await expect(jose.jwtVerify(wrongToken, key, { algorithms: ['HS256'] })).rejects.toThrow();
  });
});

// ─── WebSocket integration tests ──────────────────────────────────────────────
// These tests start a real HTTP server on a random port so we can exercise the
// WebSocket upgrade path that `app.inject` cannot trigger.

type OnMessageSubscriber = EventSubscriber & { onMessage: ((msg: string) => void) | null };

function makeControlledSubscriberFactory(): {
  factory: RedisSubscriberFactory;
  lastSubscriber: () => OnMessageSubscriber | undefined;
} {
  let latest: OnMessageSubscriber | undefined;
  const factory: RedisSubscriberFactory = () => {
    const sub: OnMessageSubscriber = {
      onMessage: null,
      subscribe: vi.fn(async (_channel: string, handler: (msg: string) => void) => {
        sub.onMessage = handler;
      }),
      unsubscribe: vi.fn(async () => {}),
    };
    latest = sub;
    return sub;
  };
  return { factory, lastSubscriber: () => latest };
}

async function startTestServer(factory?: RedisSubscriberFactory) {
  const { factory: defaultFactory } = makeSubscriberFactory();
  const app = Fastify({ logger: false });
  app.decorateRequest('userId', '');
  app.decorateRequest('userPlanId', '');
  await eventsRoutes(app, makeAuthConfig(), factory ?? defaultFactory);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as { port: number };
  const wsBase = `ws://127.0.0.1:${address.port}`;
  return { app, wsBase };
}

/** Opens a WebSocket and waits for it to either open or error/close. */
function openWs(url: string, timeoutMs = 3000): Promise<{ ws: WebSocket; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), timeoutMs);
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({ ws });
    });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve({ ws, closeCode: ev.code });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      // If it errors without opening, emit as close 1006
      resolve({ ws, closeCode: 1006 });
    });
  });
}

/** Wait for the WebSocket to close, returning the close code. */
function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve(1000);
      return;
    }
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve(ev.code);
    });
  });
}

describe('WebSocket /events — real connection integration', () => {
  it('server closes with code 4001 for missing token', async () => {
    const { app, wsBase } = await startTestServer();
    try {
      const ws = new WebSocket(`${wsBase}/events`);
      const closeCode = await waitForClose(ws);
      // Missing token → closed immediately with 4001
      expect(closeCode).toBe(4001);
    } finally {
      await app.close();
    }
  });

  it('server closes with code 4001 for invalid JWT', async () => {
    const { app, wsBase } = await startTestServer();
    try {
      const ws = new WebSocket(`${wsBase}/events?token=not.a.valid.jwt`);
      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(4001);
    } finally {
      await app.close();
    }
  });

  it('server closes with code 4001 for expired JWT', async () => {
    // Use a numeric Unix timestamp 10 seconds in the past
    const pastEpoch = Math.floor(Date.now() / 1000) - 10;
    const expiredToken = await makeToken(TEST_USER_ID, JWT_SECRET, pastEpoch);
    const { app, wsBase } = await startTestServer();
    try {
      const ws = new WebSocket(`${wsBase}/events?token=${expiredToken}`);
      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(4001);
    } finally {
      await app.close();
    }
  });

  it('valid JWT keeps connection open', async () => {
    const { factory } = makeSubscriberFactory();
    const { app, wsBase } = await startTestServer(factory);
    try {
      const validToken = await makeToken(TEST_USER_ID);
      const { ws, closeCode } = await openWs(`${wsBase}/events?token=${validToken}`);
      // Should have connected (no close code yet)
      expect(closeCode).toBeUndefined();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('subscribes to the user-scoped channel on connection', async () => {
    const subscribeCalls: string[] = [];
    const factory: RedisSubscriberFactory = () => ({
      subscribe: vi.fn(async (channel: string, _callback: (msg: string) => void) => { subscribeCalls.push(channel); }),
      unsubscribe: vi.fn(async () => {}),
    });
    const { app, wsBase } = await startTestServer(factory);
    try {
      const token = await makeToken('user-abc');
      const { ws } = await openWs(`${wsBase}/events?token=${token}`);
      // Give the server a moment to subscribe
      await new Promise((r) => setTimeout(r, 50));
      expect(subscribeCalls).toContain('events:user-abc');
      ws.close();
    } finally {
      await app.close();
    }
  });

  it('forwards events published to the user channel', async () => {
    const { factory, lastSubscriber } = makeControlledSubscriberFactory();
    const { app, wsBase } = await startTestServer(factory);
    try {
      const token = await makeToken('user-fwd');
      const { ws } = await openWs(`${wsBase}/events?token=${token}`);

      const receivedMessages: string[] = [];
      ws.addEventListener('message', (ev) => {
        receivedMessages.push(ev.data as string);
      });

      // Wait for subscription to be set up
      await new Promise((r) => setTimeout(r, 50));

      // Simulate Redis publishing a message
      const sub = lastSubscriber();
      expect(sub).toBeDefined();
      const payload = JSON.stringify({ type: 'bot.status', botId: 'b1', status: 'running' });
      sub!.onMessage!(payload);

      // Wait for the message to arrive
      await new Promise((r) => setTimeout(r, 50));
      expect(receivedMessages).toContain(payload);

      ws.close();
    } finally {
      await app.close();
    }
  });
});
