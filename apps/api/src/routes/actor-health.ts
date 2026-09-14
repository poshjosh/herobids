import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents } from '@herobids/db';
import type { ActorHealthSnapshot } from '@herobids/domain';
import { actorHealthKey } from '@herobids/domain';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { errorPayload } from '../error-payload.js';
import { createTradertonReadBoundary, loadBoundaryObject } from './exports-traderton.js';

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export async function actorHealthRoutes(
  app: FastifyInstance,
  db: Database,
  redis: Redis,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  // GET /agents/:id/health — runtime health snapshot for an agent
  app.get<{ Params: { id: string } }>('/agents/:id/health', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id, status: agents.status }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const key = actorHealthKey('agent', id);
    const raw = await redis.get(key);
    if (!raw) {
      // No live snapshot — derive from static DB status
      return reply.send({
        actorType: 'agent',
        actorId: id,
        status: agent.status === 'active' ? 'degraded' : agent.status as string,
        reasons: raw === null ? ['no_runtime_snapshot'] : [],
        updatedAt: new Date().toISOString(),
        source: 'static',
      });
    }

    const snapshot = JSON.parse(raw) as ActorHealthSnapshot;
    return reply.send({ ...snapshot, source: 'runtime' });
  });

  // GET /bots/:id/health — runtime health snapshot for a bot. Ownership + the
  // static-status fallback source the bot's status over the Traderton read
  // boundary (c4.2): `get_owner_bot_status` owner-verifies (unowned/absent →
  // not_found.resource → 404) and returns the status used for the static fallback.
  app.get<{ Params: { id: string } }>('/bots/:id/health', async (request, reply) => {
    const { id } = request.params;

    if (!tradertonReadClient) {
      return reply.status(503).send(errorPayload(
        'precondition.not_ready',
        'Trading service is unavailable — bot health could not be read.',
      ));
    }
    const subject: TradertonSubject = { ownerId: request.userId, actor: { type: 'user', id: request.userId } };
    const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
    const loaded = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: id });
    if (!loaded.ok) {
      if (loaded.error.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(loaded.error.status).send(errorPayload(loaded.error.code, loaded.error.message));
    }
    const bot = { status: loaded.data['status'] as string };

    const key = actorHealthKey('bot', id);
    const raw = await redis.get(key);
    if (!raw) {
      return reply.send({
        actorType: 'bot',
        actorId: id,
        status: bot.status === 'running' ? 'degraded' : bot.status as string,
        reasons: ['no_runtime_snapshot'],
        updatedAt: new Date().toISOString(),
        source: 'static',
      });
    }

    const snapshot = JSON.parse(raw) as ActorHealthSnapshot;
    return reply.send({ ...snapshot, source: 'runtime' });
  });
}
