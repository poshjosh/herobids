import type { FastifyInstance } from 'fastify';
import type { Database } from '@herobids/db';
import { ReconciliationEventRepository } from '@herobids/db';
import { ReconciliationEventQuerySchema } from '../schemas.js';

export async function reconciliationRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const reconRepo = new ReconciliationEventRepository(db);

  // Query reconciliation events for a trading instance
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/instances/:id/reconciliation-events',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = ReconciliationEventQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const events = await reconRepo.getByInstance(id, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        since: parsed.data.since ? new Date(parsed.data.since) : undefined,
        result: parsed.data.result,
      });

      return reply.send({ tradingInstanceId: id, events });
    },
  );
}
