import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { eq, and, ne } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { tradingInstances } from '@herobids/db';
import { TradingInstanceConfigSchema } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import type { LifecycleJob } from '../types.js';

export async function instanceRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database): Promise<void> {
  // Create trading instance
  app.post('/instances', async (request, reply) => {
    const parsed = CreateInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Validate the config shape
    const configResult = TradingInstanceConfigSchema.safeParse(parsed.data.config);
    if (!configResult.success) {
      return reply.status(400).send({ error: 'invalid_config', details: configResult.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(tradingInstances).values({
      id,
      userId: parsed.data.userId,
      portfolioId: parsed.data.portfolioId,
      venueAccountId: parsed.data.venueAccountId,
      strategyId: parsed.data.strategyId,
      config: parsed.data.config,
      status: 'stopped',
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    });

    const [instance] = await db.select().from(tradingInstances).where(eq(tradingInstances.id, id));
    return reply.status(201).send(instance);
  });

  // Start a trading instance
  app.post<{ Params: { id: string } }>('/instances/:id/start', async (request, reply) => {
    const { id } = request.params;

    const [instance] = await db.select().from(tradingInstances).where(eq(tradingInstances.id, id));
    if (!instance) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (instance.status === 'running') {
      return reply.status(409).send({ error: 'already_running', tradingInstanceId: id });
    }

    // Check for another non-stopped instance on the same venue account (unique constraint guard)
    const [blocker] = await db.select({ id: tradingInstances.id, status: tradingInstances.status })
      .from(tradingInstances)
      .where(and(
        eq(tradingInstances.venueAccountId, instance.venueAccountId),
        ne(tradingInstances.id, id),
        ne(tradingInstances.status, 'stopped'),
      ));

    if (blocker) {
      if (blocker.status === 'crashed') {
        // Crashed instances are inert — clear them to free the slot
        await db.update(tradingInstances)
          .set({ status: 'stopped', updatedAt: new Date() })
          .where(eq(tradingInstances.id, blocker.id));
        await queue.add('stop-instance', { command: 'stop', tradingInstanceId: blocker.id });
      } else {
        // A legitimately running instance holds this venue account
        return reply.status(409).send({
          error: 'venue_account_conflict',
          message: `Another instance (${blocker.id}) is already ${blocker.status} on this venue account`,
          blockingInstanceId: blocker.id,
        });
      }
    }

    try {
      const [updated] = await db.update(tradingInstances)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tradingInstances.id, id), ne(tradingInstances.status, 'running')))
        .returning({ id: tradingInstances.id });

      if (!updated) {
        // Concurrent request already moved this instance to running
        return reply.status(409).send({ error: 'already_running', tradingInstanceId: id });
      }
    } catch (err: unknown) {
      // Unique constraint race: another concurrent start claimed this venue account between our check and update
      const pgErr = err as { code?: string; constraint_name?: string };
      if (pgErr.code === '23505' && pgErr.constraint_name === 'uq_trading_instances_active_venue_account') {
        return reply.status(409).send({
          error: 'venue_account_conflict',
          message: 'Another instance was started on this venue account concurrently',
        });
      }
      throw err;
    }

    await queue.add('start-instance', {
      command: 'start',
      tradingInstanceId: id,
      config: { ...instance.config, venueAccountId: instance.venueAccountId },
    });
    return reply.send({ status: 'starting', tradingInstanceId: id });
  });

  // Stop a trading instance
  app.post<{ Params: { id: string } }>('/instances/:id/stop', async (request, reply) => {
    const { id } = request.params;

    await db.update(tradingInstances)
      .set({ status: 'stopped', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(tradingInstances.id, id));

    await queue.add('stop-instance', {
      command: 'stop',
      tradingInstanceId: id,
    });
    return reply.send({ status: 'stopping', tradingInstanceId: id });
  });

  // Update instance config
  app.patch<{ Params: { id: string } }>('/instances/:id/config', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateInstanceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [existing] = await db.select().from(tradingInstances).where(eq(tradingInstances.id, id));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Validate the config shape (same as create path)
    const configResult = TradingInstanceConfigSchema.safeParse(parsed.data.config);
    if (!configResult.success) {
      return reply.status(400).send({ error: 'invalid_config', details: configResult.error.issues });
    }

    const newVersion = existing.configVersion + 1;
    await db.update(tradingInstances)
      .set({
        config: parsed.data.config,
        configVersion: newVersion,
        updatedAt: new Date(),
      })
      .where(eq(tradingInstances.id, id));

    // Restart if running to pick up new config
    if (existing.status === 'running') {
      await queue.add('restart-instance', {
        command: 'restart',
        tradingInstanceId: id,
        config: { ...parsed.data.config, venueAccountId: existing.venueAccountId },
      });
    }

    return reply.send({ status: 'updated', tradingInstanceId: id, configVersion: newVersion });
  });

  // List instances
  app.get('/instances', async (_request, reply) => {
    const instances = await db.select().from(tradingInstances);
    return reply.send({ instances });
  });

  // Get single instance
  app.get<{ Params: { id: string } }>('/instances/:id', async (request, reply) => {
    const { id } = request.params;
    const [instance] = await db.select().from(tradingInstances).where(eq(tradingInstances.id, id));
    if (!instance) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(instance);
  });
}
