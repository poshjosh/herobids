import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { venueAccounts, portfolios, credentials } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { CreateVenueAccountSchema, CreatePortfolioSchema } from '../schemas.js';
import { checkVenueAccountLimit, checkPortfolioLimit } from '../plan-guards.js';

export async function venueAccountRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // Create venue account
  app.post('/venue-accounts', async (request, reply) => {
    const parsed = CreateVenueAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkVenueAccountLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    // Validate credential linkage if credentialId is provided — scope the lookup by userId so
    // that a credential owned by another user returns the same "not found" response as a
    // genuinely missing credential (prevents probing foreign credential IDs).
    if (parsed.data.credentialId) {
      const [cred] = await db
        .select({ id: credentials.id, venue: credentials.venue })
        .from(credentials)
        .where(and(eq(credentials.id, parsed.data.credentialId), eq(credentials.userId, request.userId)));

      if (!cred) {
        return reply.status(400).send({
          error: 'credential.not_found',
          message: `Credential ${parsed.data.credentialId} does not exist`,
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
        userId: request.userId,
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
  app.get('/venue-accounts', async (request, reply) => {
    const accounts = await db.select().from(venueAccounts).where(eq(venueAccounts.userId, request.userId));
    return reply.send({ venueAccounts: accounts });
  });
}

export async function portfolioRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // Create portfolio
  app.post('/portfolios', async (request, reply) => {
    const parsed = CreatePortfolioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkPortfolioLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    const id = crypto.randomUUID();

    await db.insert(portfolios).values({
      id,
      userId: request.userId,
      name: parsed.data.name,
    });

    const [portfolio] = await db.select().from(portfolios).where(eq(portfolios.id, id));
    return reply.status(201).send(portfolio);
  });

  // List portfolios
  app.get('/portfolios', async (request, reply) => {
    const all = await db.select().from(portfolios).where(eq(portfolios.userId, request.userId));
    return reply.send({ portfolios: all });
  });
}
