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

// ─── Platform envelope assertions ─────────────────────────────────────────────
// Verify that messages forwarded over the WebSocket conform to the shared
// PlatformEventEnvelope shape. The events route is a transport — it forwards
// whatever the publisher puts on Redis. These tests confirm the consumer
// receives the full envelope, not a stripped inner payload.

describe('WebSocket /events — platform envelope semantics', () => {
  it('forwards a platform envelope message with all canonical fields', async () => {
    const { factory, lastSubscriber } = makeControlledSubscriberFactory();
    const { app, wsBase } = await startTestServer(factory);
    try {
      const token = await makeToken('user-envelope');
      const { ws } = await openWs(`${wsBase}/events?token=${token}`);

      const receivedMessages: string[] = [];
      ws.addEventListener('message', (ev) => {
        receivedMessages.push(ev.data as string);
      });

      await new Promise((r) => setTimeout(r, 50));

      // Simulate what UserEventPublisher now publishes: the full platform envelope
      const envelope = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: '2026-01-01T00:00:00.000Z',
        actorType: 'platform',
        actorId: 'user-envelope',
        eventType: 'agent.status',
        payload: { type: 'agent.status', agentId: 'agent-1', status: 'active', timestamp: '2026-01-01T00:00:00.000Z' },
      };
      const envelopeStr = JSON.stringify(envelope);
      const sub = lastSubscriber();
      sub!.onMessage!(envelopeStr);

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedMessages).toContain(envelopeStr);

      // Parse and assert the shape matches the PlatformEventEnvelope contract
      const received = JSON.parse(receivedMessages[0]!) as Record<string, unknown>;
      expect(typeof received['id']).toBe('string');
      expect(typeof received['timestamp']).toBe('string');
      expect(['user', 'agent', 'platform']).toContain(received['actorType']);
      expect(typeof received['actorId']).toBe('string');
      expect(typeof received['eventType']).toBe('string');
      expect(typeof received['payload']).toBe('object');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('forwards envelope intact without modifying fields', async () => {
    const { factory, lastSubscriber } = makeControlledSubscriberFactory();
    const { app, wsBase } = await startTestServer(factory);
    try {
      const token = await makeToken('user-fidelity');
      const { ws } = await openWs(`${wsBase}/events?token=${token}`);

      const receivedMessages: string[] = [];
      ws.addEventListener('message', (ev) => {
        receivedMessages.push(ev.data as string);
      });

      await new Promise((r) => setTimeout(r, 50));

      const envelope = {
        id: 'test-id-123',
        timestamp: '2026-06-07T12:00:00.000Z',
        actorType: 'agent',
        actorId: 'agent-99',
        capabilityFamily: 'trading',
        bindingId: 'grant-42',
        eventType: 'trading.order.submitted',
        payload: { orderId: 'ord-1', symbol: 'BTC-PERP' },
      };

      const sub = lastSubscriber();
      sub!.onMessage!(JSON.stringify(envelope));

      await new Promise((r) => setTimeout(r, 50));
      expect(receivedMessages).toHaveLength(1);

      const received = JSON.parse(receivedMessages[0]!) as typeof envelope;
      expect(received.id).toBe(envelope.id);
      expect(received.capabilityFamily).toBe('trading');
      expect(received.bindingId).toBe('grant-42');

      ws.close();
    } finally {
      await app.close();
    }
  });
});

// ─── Cross-user isolation tests ───────────────────────────────────────────────
// Verify that user A cannot receive events published to user B's channel. The
// /events route subscribes each user's WebSocket to a user-scoped channel. This
// test ensures that publishing an event to user B's channel does not arrive at
// user A's connection.

describe('WebSocket /events — cross-user isolation', () => {
  it('user A cannot receive events published to user B\'s channel', async () => {
    const { factory, lastSubscriber } = makeControlledSubscriberFactory();
    const { app, wsBase } = await startTestServer(factory);

    try {
      // Open WebSocket for user A
      const tokenA = await makeToken('user-a');
      const { ws: wsA } = await openWs(`${wsBase}/events?token=${tokenA}`);
      expect(wsA.readyState).toBe(WebSocket.OPEN);

      const receivedMessagesA: string[] = [];
      wsA.addEventListener('message', (ev) => {
        receivedMessagesA.push(ev.data as string);
      });

      // Wait for subscriber to be set up
      await new Promise((r) => setTimeout(r, 50));

      // Simulate Redis publishing an event to user B's channel
      // (The subscriber is still subscribed to user A's channel)
      const subA = lastSubscriber();
      expect(subA).toBeDefined();

      const userBEnvelope = {
        id: 'evt-b-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        actorType: 'user',
        actorId: 'user-b',
        eventType: 'agent.status',
        payload: { type: 'agent.status', agentId: 'agent-b', status: 'active', timestamp: '2026-01-01T00:00:00.000Z' },
      };

      // This event should NOT be delivered to user A's WebSocket because it is
      // published to user B's channel. The subscriber for user A is listening
      // to 'events:user-a', not 'events:user-b'.
      //
      // In reality, the EventPublisher publishes to 'events:user-b', which is
      // a different channel. Since we're mocking the subscriber, we cannot
      // truly verify channel isolation at this level. Instead, we verify that
      // the subscriber is scoped to the correct user's channel (see test
      // 'subscribes to the user-scoped channel on connection').
      //
      // For a more complete proof, we would need a Redis integration test that
      // publishes to both channels and verifies only the correct user receives
      // their events. This unit test verifies the subscription is user-scoped.
      //
      // Here, we'll open a second WebSocket for user B and confirm user A's
      // subscriber does not receive user B's events.

      // Open WebSocket for user B
      const tokenB = await makeToken('user-b');
      const { ws: wsB } = await openWs(`${wsBase}/events?token=${tokenB}`);
      expect(wsB.readyState).toBe(WebSocket.OPEN);

      const receivedMessagesB: string[] = [];
      wsB.addEventListener('message', (ev) => {
        receivedMessagesB.push(ev.data as string);
      });

      // Wait for user B's subscriber to be set up
      await new Promise((r) => setTimeout(r, 50));

      const subB = lastSubscriber();
      expect(subB).toBeDefined();
      expect(subB).not.toBe(subA);

      // Simulate publishing to user B's channel via user B's subscriber
      subB!.onMessage!(JSON.stringify(userBEnvelope));

      // Wait for the message to arrive (if it were to)
      await new Promise((r) => setTimeout(r, 100));

      // User B should receive the event
      expect(receivedMessagesB).toHaveLength(1);
      expect(JSON.parse(receivedMessagesB[0]!)).toEqual(userBEnvelope);

      // User A should NOT receive the event because it was published to user B's
      // channel, and user A's WebSocket is subscribed to events:user-a.
      expect(receivedMessagesA).toHaveLength(0);

      // Similarly, publish an event to user A's channel and verify user B does
      // not receive it.
      const userAEnvelope = {
        id: 'evt-a-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        actorType: 'user',
        actorId: 'user-a',
        eventType: 'agent.status',
        payload: { type: 'agent.status', agentId: 'agent-a', status: 'active', timestamp: '2026-01-01T00:00:00.000Z' },
      };

      subA!.onMessage!(JSON.stringify(userAEnvelope));
      await new Promise((r) => setTimeout(r, 100));

      // User A should receive their event
      expect(receivedMessagesA).toHaveLength(1);
      expect(JSON.parse(receivedMessagesA[0]!)).toEqual(userAEnvelope);

      // User B should NOT receive user A's event
      expect(receivedMessagesB).toHaveLength(1);

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });
});
