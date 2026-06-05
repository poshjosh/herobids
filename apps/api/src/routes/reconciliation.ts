import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { ReconciliationEventRepository, bots } from '@herobids/db';
import { ReconciliationEventQuerySchema } from '../schemas.js';

export async function reconciliationRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const reconRepo = new ReconciliationEventRepository(db);

  // Query reconciliation events for a bot's venue account
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/bots/:id/reconciliation-events',
    async (request, reply) => {
      const { id } = request.params;

      // Verify ownership and get venueAccountId
      const [bot] = await db.select({ id: bots.id, venueAccountId: bots.venueAccountId }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const parsed = ReconciliationEventQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const events = await reconRepo.getByVenueAccount(bot.venueAccountId, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      });

      return reply.send({ botId: id, venueAccountId: bot.venueAccountId, events });
    },
  );
}
