import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, portfolios, credentials } from '@herobids/db';
import { CreateVenueAccountSchema, CreatePortfolioSchema } from '../schemas.js';

export async function venueAccountRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // Create venue account
  app.post('/venue-accounts', async (request, reply) => {
    const parsed = CreateVenueAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Validate credential linkage if credentialId is provided
    if (parsed.data.credentialId) {
      const [cred] = await db
        .select({ id: credentials.id, userId: credentials.userId, venue: credentials.venue })
        .from(credentials)
        .where(eq(credentials.id, parsed.data.credentialId));

      if (!cred) {
        return reply.status(400).send({
          error: 'credential.not_found',
          message: `Credential ${parsed.data.credentialId} does not exist`,
        });
      }

      if (cred.userId !== parsed.data.userId) {
        return reply.status(400).send({
          error: 'credential.user_mismatch',
          message: 'Credential belongs to a different user',
        });
      }

      if (cred.venue !== parsed.data.venue) {
        return reply.status(400).send({
          error: 'credential.venue_mismatch',
          message: `Credential is for venue "${cred.venue}", not "${parsed.data.venue}"`,
        });
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();

    try {
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
    } catch (err: unknown) {
      // FK violation — credential deleted between validation and insert
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        return reply.status(400).send({
          error: 'credential.not_found',
          message: `Credential ${parsed.data.credentialId} was removed before the account could be created`,
        });
      }
      throw err;
    }

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
