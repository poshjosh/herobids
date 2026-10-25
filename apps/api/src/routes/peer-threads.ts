import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@herobids/db';
import { agents } from '@herobids/db';
import {
  ConversationQuerySchema,
  conversationErrorResponse,
  decodeConversationCursor,
  encodeConversationCursor,
  toPeerMessageResponse,
  type ConversationRouteDeps,
} from './conversation-http.js';

const PeerThreadListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
});

/**
 * The owner's view of agent-to-agent threads (A2A MVP, DEC-43). Read only, user callers only: an agent key gets
 * no `agentAccess`, so it cannot read a thread. Peer messages are written by the worker, never through these routes.
 */
export async function peerThreadRoutes(app: FastifyInstance, db: Database, conversations: ConversationRouteDeps): Promise<void> {
  // GET /agents/:id/peer-threads — the agent's threads with other agents, newest message first, with the peer's name.
  // Two reads for the threads (conversations, then their participants) and one for the names, whatever the page size.
  app.get<{ Params: { id: string }; Querystring: unknown }>('/agents/:id/peer-threads', async (request, reply) => {
    const { id } = request.params;
    const query = PeerThreadListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'validation_error', details: query.error.issues });
    }
    const [agent] = await db.select({ id: agents.id })
      .from(agents).where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const threads = await conversations.service.listPeerThreads({
      ownerUserId: request.userId,
      agentId: id,
      ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
    });
    if (!threads.ok) {
      if (threads.error.code === 'conversation.store_failed') {
        request.log.error({ err: threads.error }, 'conversation store failed on peer thread list');
      }
      const failure = conversationErrorResponse(threads.error);
      return reply.status(failure.status).send(failure.body);
    }

    const peerIds = threads.data.map((thread) => thread.peerAgentId);
    const names = peerIds.length === 0
      ? []
      : await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(and(eq(agents.userId, request.userId), inArray(agents.id, peerIds)));
    const nameById = new Map(names.map((row) => [row.id, row.name]));

    return reply.send({
      threads: threads.data.map((thread) => ({
        kind: 'agent_agent' as const,
        peerAgentId: thread.peerAgentId,
        peerAgentName: nameById.get(thread.peerAgentId) ?? null,
        lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
      })),
    });
  });

  // GET /agents/:id/peer-threads/:peerAgentId — the messages between two of the owner's agents, oldest first, paged like
  // GET /agents/:id/conversation (the same opaque cursor).
  app.get<{ Params: { id: string; peerAgentId: string }; Querystring: unknown }>('/agents/:id/peer-threads/:peerAgentId', async (request, reply) => {
    const { id, peerAgentId } = request.params;
    const query = ConversationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'validation_error', details: query.error.issues });
    }
    const cursor = query.data.before === undefined ? null : decodeConversationCursor(query.data.before);
    if (query.data.before !== undefined && !cursor) {
      return reply.status(400).send({ error: 'validation_error', message: 'invalid_cursor' });
    }

    // Both agents must be the caller's: a thread of another user's agent is not found, so ids cannot be probed.
    const owned = await db.select({ id: agents.id, name: agents.name })
      .from(agents).where(and(eq(agents.userId, request.userId), inArray(agents.id, [id, peerAgentId])));
    const peer = owned.find((row) => row.id === peerAgentId);
    if (id === peerAgentId || !owned.some((row) => row.id === id) || !peer) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const pageSize = Math.min(query.data.limit ?? conversations.limits.threadDefaultPageSize, conversations.limits.threadMaxPageSize);
    const thread = await conversations.service.listPeerThread({
      ownerUserId: request.userId,
      agentId: id,
      peerAgentId,
      limit: pageSize,
      ...(cursor ? { before: cursor.before, beforeId: cursor.beforeId } : {}),
    });
    if (!thread.ok) {
      if (thread.error.code === 'conversation.store_failed') {
        request.log.error({ err: thread.error }, 'conversation store failed on peer thread read');
      }
      const failure = conversationErrorResponse(thread.error);
      return reply.status(failure.status).send(failure.body);
    }
    const oldest = thread.data[0];
    return reply.send({
      kind: 'agent_agent' as const,
      peerAgentId,
      peerAgentName: peer.name,
      messages: thread.data.map(toPeerMessageResponse),
      nextCursor: oldest && thread.data.length >= pageSize ? encodeConversationCursor(oldest) : null,
    });
  });
}
