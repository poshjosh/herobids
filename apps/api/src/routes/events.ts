import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import * as jose from 'jose';
import type { AuthConfig } from '@herobids/domain';

// Redis pub/sub channel naming convention: events:<userId>
function userChannel(userId: string): string {
  return `events:${userId}`;
}

// Ping interval (ms) — server sends a WebSocket ping every 30 seconds on idle connections.
const PING_INTERVAL_MS = 30_000;

// Pong timeout (ms) — close connection if no pong received within this window.
const PONG_TIMEOUT_MS = 10_000;

export type EventSubscriber = {
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
};

/**
 * Create a per-connection Redis subscriber using the provided factory.
 * The factory must return a fresh Redis client (one sub-client per connection is required
 * because ioredis puts the client in subscriber mode after the first subscribe call).
 */
export type RedisSubscriberFactory = () => EventSubscriber;

export async function eventsRoutes(
  app: FastifyInstance,
  authConfig: AuthConfig,
  subscriberFactory: RedisSubscriberFactory,
): Promise<void> {
  await app.register(websocketPlugin);

  const secret = new TextEncoder().encode(authConfig.jwtSecret);

  app.get('/events', { websocket: true }, (socket, request) => {
    // The JWT must be provided as a query parameter because browsers cannot set
    // Authorization headers on WebSocket upgrade requests.
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    // Validate JWT and set up subscription asynchronously.
    // We must not do async work in the connection handler body directly (Fastify websocket
    // handler is sync), so we schedule validation and immediately close on failure.
    let closed = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    let subscriber: EventSubscriber | null = null;
    let subscribedChannel: string | null = null;

    async function setup(): Promise<void> {
      let userId: string;
      try {
        const { payload } = await jose.jwtVerify(token, secret, { algorithms: ['HS256'] });
        if (!payload.sub) throw new Error('No sub claim');
        userId = payload.sub;
      } catch {
        socket.close(4001, 'Invalid or expired token');
        return;
      }

      if (closed) return;

      // Subscribe to the user's Redis event channel.
      subscriber = subscriberFactory();
      subscribedChannel = userChannel(userId);

      await subscriber.subscribe(subscribedChannel, (message) => {
        if (closed) return;
        try {
          socket.send(message);
        } catch {
          // Socket may have closed between the check and the send — ignore.
        }
      });

      // Start ping/pong heartbeat.
      pingTimer = setInterval(() => {
        if (closed) {
          if (pingTimer) clearInterval(pingTimer);
          return;
        }
        try {
          socket.ping();
          pongTimer = setTimeout(() => {
            // No pong received — close the connection.
            socket.close(1001, 'Pong timeout');
          }, PONG_TIMEOUT_MS);
        } catch {
          if (pingTimer) clearInterval(pingTimer);
        }
      }, PING_INTERVAL_MS);
    }

    // Kick off async setup; close on unhandled error.
    setup().catch(() => {
      socket.close(1011, 'Internal error during setup');
    });

    // Clear the pong timeout when the client responds.
    socket.on('pong', () => {
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    });

    socket.on('close', () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      if (subscriber && subscribedChannel) {
        subscriber.unsubscribe(subscribedChannel).catch(() => {
          // Best-effort cleanup.
        });
      }
    });
  });
}
