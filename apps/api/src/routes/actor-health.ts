import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, bots } from '@herobids/db';
import type { ActorHealthSnapshot } from '@herobids/domain';
import { actorHealthKey } from '@herobids/domain';

export async function actorHealthRoutes(app: FastifyInstance, db: Database, redis: Redis): Promise<void> {
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

  // GET /bots/:id/health — runtime health snapshot for a bot
  app.get<{ Params: { id: string } }>('/bots/:id/health', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select({ id: bots.id, status: bots.status }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

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
