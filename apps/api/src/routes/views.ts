import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { PgJournal, PositionRepository, BacktestingRepository, tradingInstances, portfolios } from '@herobids/db';
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
    if (!parsed.data.tradingInstanceId && !parsed.data.backtestRunId) {
      return reply.status(400).send({ error: 'validation_error', message: 'Either tradingInstanceId or backtestRunId filter is required' });
    }

    // Verify ownership of tradingInstanceId if provided
    if (parsed.data.tradingInstanceId) {
      const [instance] = await db.select({ id: tradingInstances.id }).from(tradingInstances)
        .where(and(eq(tradingInstances.id, parsed.data.tradingInstanceId), eq(tradingInstances.userId, request.userId)));
      if (!instance) {
        return reply.status(404).send({ error: 'not_found' });
      }
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

  // List positions for a trading instance
  app.get<{ Params: { instanceId: string } }>('/instances/:instanceId/positions', async (request, reply) => {
    const { instanceId } = request.params;
    const [instance] = await db.select({ id: tradingInstances.id }).from(tradingInstances)
      .where(and(eq(tradingInstances.id, instanceId), eq(tradingInstances.userId, request.userId)));
    if (!instance) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getAllByInstance(instanceId);
    return reply.send({ tradingInstanceId: instanceId, positions });
  });

  // Open positions only
  app.get<{ Params: { instanceId: string } }>('/instances/:instanceId/positions/open', async (request, reply) => {
    const { instanceId } = request.params;
    const [instance] = await db.select({ id: tradingInstances.id }).from(tradingInstances)
      .where(and(eq(tradingInstances.id, instanceId), eq(tradingInstances.userId, request.userId)));
    if (!instance) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getOpenByInstance(instanceId);
    return reply.send({ tradingInstanceId: instanceId, positions });
  });
}

export async function portfolioPositionRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const positionRepo = new PositionRepository(db);

  // All positions in a portfolio (across all instances)
  app.get<{ Params: { portfolioId: string } }>('/portfolios/:portfolioId/positions', async (request, reply) => {
    const { portfolioId } = request.params;
    const [portfolio] = await db.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, request.userId)));
    if (!portfolio) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getAllByPortfolio(portfolioId);
    return reply.send({ portfolioId, positions });
  });

  // Open positions in a portfolio
  app.get<{ Params: { portfolioId: string } }>('/portfolios/:portfolioId/positions/open', async (request, reply) => {
    const { portfolioId } = request.params;
    const [portfolio] = await db.select({ id: portfolios.id }).from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, request.userId)));
    if (!portfolio) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const positions = await positionRepo.getOpenByPortfolio(portfolioId);
    return reply.send({ portfolioId, positions });
  });
}
