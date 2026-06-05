import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { PgJournal, PositionRepository, BacktestingRepository, bots } from '@herobids/db';
import { JournalQuerySchema } from '../schemas.js';

export async function journalRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const journal = new PgJournal(db);
  const backtestRepo = new BacktestingRepository(db);

  // Query journal events — requires at least one ownership-scoped filter
  app.get('/journal', async (request, reply) => {
    const parsed = JournalQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Require at least one ownership-scoped filter to prevent cross-user data leaks
    if (!parsed.data.actorId && !parsed.data.backtestRunId) {
      return reply.status(400).send({ error: 'validation_error', message: 'Either actorId or backtestRunId filter is required' });
    }

    // Verify ownership of backtestRunId if provided
    if (parsed.data.backtestRunId) {
      const run = await backtestRepo.getBacktestRunForUser(parsed.data.backtestRunId, request.userId);
      if (!run) {
        return reply.status(404).send({ error: 'not_found' });
      }
    }

    const events = await journal.query(parsed.data);
    return reply.send({ events });
  });
}

export async function positionRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const positionRepo = new PositionRepository(db);

  // List positions for a bot
  app.get<{ Params: { botId: string } }>('/bots/:botId/positions', async (request, reply) => {
    const { botId } = request.params;
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getAllByActor('bot', botId);
    return reply.send({ botId, positions });
  });

  // Open positions only
  app.get<{ Params: { botId: string } }>('/bots/:botId/positions/open', async (request, reply) => {
    const { botId } = request.params;
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getOpenByActor('bot', botId);
    return reply.send({ botId, positions });
  });
}
