import type { FastifyInstance } from 'fastify';
import type { Database } from '@herobids/db';
import { PgJournal, PositionRepository } from '@herobids/db';
import { JournalQuerySchema } from '../schemas.js';

export async function journalRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const journal = new PgJournal(db);

  // Query journal events
  app.get('/journal', async (request, reply) => {
    const parsed = JournalQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const events = await journal.query(parsed.data);
    return reply.send({ events });
  });
}

export async function positionRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const positionRepo = new PositionRepository(db);

  // List positions for a trading instance
  app.get<{ Params: { instanceId: string } }>('/instances/:instanceId/positions', async (request, reply) => {
    const { instanceId } = request.params;
    const positions = await positionRepo.getAllByInstance(instanceId);
    return reply.send({ tradingInstanceId: instanceId, positions });
  });

  // Open positions only
  app.get<{ Params: { instanceId: string } }>('/instances/:instanceId/positions/open', async (request, reply) => {
    const { instanceId } = request.params;
    const positions = await positionRepo.getOpenByInstance(instanceId);
    return reply.send({ tradingInstanceId: instanceId, positions });
  });
}

export async function portfolioPositionRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const positionRepo = new PositionRepository(db);

  // All positions in a portfolio (across all instances)
  app.get<{ Params: { portfolioId: string } }>('/portfolios/:portfolioId/positions', async (request, reply) => {
    const { portfolioId } = request.params;
    const positions = await positionRepo.getAllByPortfolio(portfolioId);
    return reply.send({ portfolioId, positions });
  });

  // Open positions in a portfolio
  app.get<{ Params: { portfolioId: string } }>('/portfolios/:portfolioId/positions/open', async (request, reply) => {
    const { portfolioId } = request.params;
    const positions = await positionRepo.getOpenByPortfolio(portfolioId);
    return reply.send({ portfolioId, positions });
  });
}
