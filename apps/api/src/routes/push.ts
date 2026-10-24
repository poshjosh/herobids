import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAllowedPushServiceHost } from '@herobids/domain';
import type { PushSubscriptionRepository } from '@herobids/db';

/** Public subset of messaging.notifications. The VAPID private key is never read here. */
export interface PushConfigInput {
  enabled: boolean;
  webPush: { enabled: boolean; vapidSubject: string; vapidPublicKey: string };
}

export interface PushPublicConfig {
  enabled: boolean;
  vapidPublicKey: string | null;
}

/** On only when the master switch, the Web Push switch, and the public half of the VAPID pair are all set. */
export function resolvePushPublicConfig(config: PushConfigInput): PushPublicConfig {
  const enabled = config.enabled
    && config.webPush.enabled
    && config.webPush.vapidSubject.trim() !== ''
    && config.webPush.vapidPublicKey.trim() !== '';
  return { enabled, vapidPublicKey: enabled ? config.webPush.vapidPublicKey : null };
}

/**
 * The server sends requests to whatever endpoint a user supplies, so the endpoint must be https, carry no
 * credentials, use the default port, and sit on an allowlisted browser push service host.
 */
export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '') return false;
  return isAllowedPushServiceHost(url.hostname);
}

const PushKeySchema = z.string().trim().min(1).max(512);

export const PushSubscriptionBodySchema = z.object({
  endpoint: z.string().trim().min(1).max(2048).refine(isAllowedPushEndpoint, {
    message: 'endpoint must be an https push service URL',
  }),
  keys: z.object({
    p256dh: PushKeySchema,
    auth: PushKeySchema,
  }),
});

export interface PushRouteOptions {
  store: Pick<PushSubscriptionRepository, 'upsertForUser' | 'revokeForUser'>;
  publicConfig: PushPublicConfig;
}

const MAX_USER_AGENT_LENGTH = 256;

/**
 * Authenticated Web Push routes (081 W6). The global auth hook applies; these paths are not public.
 * Responses never include the endpoint or its keys.
 */
export async function pushRoutes(app: FastifyInstance, options: PushRouteOptions): Promise<void> {
  const { store, publicConfig } = options;

  app.get('/push/config', async (_request, reply) => {
    return reply.send({ enabled: publicConfig.enabled, vapidPublicKey: publicConfig.vapidPublicKey });
  });

  app.post('/push/subscriptions', async (request, reply) => {
    if (!publicConfig.enabled) {
      return reply.status(503).send({ error: 'notification.disabled' });
    }

    const parsed = PushSubscriptionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        details: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }

    const userAgent = request.headers['user-agent']?.slice(0, MAX_USER_AGENT_LENGTH) ?? null;
    const result = await store.upsertForUser({
      userId: request.userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent,
    });
    if (!result.ok) {
      return reply.status(409).send({ error: result.error.code });
    }

    return reply.status(201).send({
      subscription: { id: result.data.id, createdAt: result.data.createdAt },
    });
  });

  // Allowed while the feature is off, so a user can still revoke a row created before it was switched off.
  app.delete<{ Params: { id: string } }>('/push/subscriptions/:id', async (request, reply) => {
    const revoked = await store.revokeForUser(request.userId, request.params.id);
    if (!revoked) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.status(204).send();
  });
}
