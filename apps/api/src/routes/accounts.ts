import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, portfolios } from '@herobids/db';
import { CreateVenueAccountSchema, CreatePortfolioSchema } from '../schemas.js';

export async function venueAccountRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // Create venue account
  app.post('/venue-accounts', async (request, reply) => {
    const parsed = CreateVenueAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(venueAccounts).values({
      id,
      userId: parsed.data.userId,
      venue: parsed.data.venue,
      label: parsed.data.label,
      venueAccountRef: parsed.data.venueAccountRef ?? null,
      credentialId: parsed.data.credentialId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, id));
    return reply.status(201).send(account);
  });

  // List venue accounts
  app.get('/venue-accounts', async (_request, reply) => {
    const accounts = await db.select().from(venueAccounts);
    return reply.send({ venueAccounts: accounts });
  });
}

export async function portfolioRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // Create portfolio
  app.post('/portfolios', async (request, reply) => {
    const parsed = CreatePortfolioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const id = crypto.randomUUID();

    await db.insert(portfolios).values({
      id,
      userId: parsed.data.userId,
      name: parsed.data.name,
    });

    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.id, id));
    return reply.status(201).send(portfolio);
  });

  // List portfolios
  app.get('/portfolios', async (_request, reply) => {
    const all = await db.select().from(portfolios);
    return reply.send({ portfolios: all });
  });
}
