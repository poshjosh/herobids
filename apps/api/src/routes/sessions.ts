import type { FastifyInstance } from 'fastify';
import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions, agents } from '@herobids/db';

export async function sessionRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /sessions — list agent runtime sessions for the authenticated user.
  // Scope: agent runtime sessions only. Bot lifecycle events are served via
  // GET /bots/:id/sessions (derived from journal events).
  app.get<{ Querystring: { limit?: string; offset?: string; agentId?: string } }>('/sessions', async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const userAgents = await db.select({ id: agents.id }).from(agents)
      .where(eq(agents.userId, request.userId));
    const agentIds = userAgents.map((a) => a.id);

    if (agentIds.length === 0) {
      return reply.send({ sessions: [], limit, offset });
    }

    const baseWhere = request.query.agentId
      ? and(eq(agentRuntimeSessions.agentId, request.query.agentId), inArray(agentRuntimeSessions.agentId, agentIds))
      : inArray(agentRuntimeSessions.agentId, agentIds);

    const sessions = await db.select().from(agentRuntimeSessions)
      .where(baseWhere)
      .orderBy(desc(agentRuntimeSessions.startedAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ sessions, limit, offset });
  });

  // GET /sessions/:id — single session, scoped to authenticated user
  app.get<{ Params: { id: string } }>('/sessions/:id', async (request, reply) => {
    const { id } = request.params;

    const [session] = await db.select().from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.id, id))
      .limit(1);

    if (!session) return reply.status(404).send({ error: 'not_found' });

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, session.agentId), eq(agents.userId, request.userId)));

    if (!agent) return reply.status(404).send({ error: 'not_found' });

    return reply.send({ session });
  });
}
