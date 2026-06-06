import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { eq, and, ne } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { bots, venueAccounts } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import { checkBotLimit, checkLiveEnabled } from '../plan-guards.js';
import type { LifecycleJob } from '../types.js';

export async function botRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // Create bot
  app.post('/bots', async (request, reply) => {
    const parsed = CreateInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkBotLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    // Verify ownership of the venue account
    const [venueAccount] = await db.select({ id: venueAccounts.id }).from(venueAccounts)
      .where(and(eq(venueAccounts.id, parsed.data.venueAccountId), eq(venueAccounts.userId, request.userId)));
    if (!venueAccount) {
      return reply.status(404).send({ error: 'not_found', message: 'Venue account not found' });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(bots).values({
      id,
      userId: request.userId,
      venueAccountId: parsed.data.venueAccountId,
      config: parsed.data.config,
      status: 'stopped',
      creatorType: 'user',
      creatorId: request.userId,
      createdAt: now,
      updatedAt: now,
    });

    const [bot] = await db.select().from(bots).where(eq(bots.id, id));
    return reply.status(201).send(bot);
  });

  // Start a bot
  app.post<{ Params: { id: string } }>('/bots/:id/start', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (bot.status === 'running') {
      return reply.status(409).send({ error: 'already_running', botId: id });
    }

    // Live-mode plan gate
    if (plansConfig) {
      const botConfig = bot.config as Record<string, unknown> | undefined;
      const executionMode = (botConfig?.['execution'] as Record<string, unknown> | undefined)?.['mode'];
      if (executionMode === 'live') {
        const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free');
        if (!liveCheck.ok) {
          return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
        }
      }
    }

    const botConfig = bot.config as Record<string, unknown> | undefined;
    const venueType = (botConfig?.['venueType'] as string | undefined) ?? 'orderbook';
    const executionMode = (botConfig?.['execution'] as Record<string, unknown> | undefined)?.['mode'];

    if (bot.venueAccountId !== 'default' && venueType !== 'swap' && executionMode !== 'paper') {
      const [venueAccount] = await db.select({ credentialId: venueAccounts.credentialId })
        .from(venueAccounts)
        .where(and(eq(venueAccounts.id, bot.venueAccountId), eq(venueAccounts.userId, request.userId)));

      if (!venueAccount) {
        return reply.status(404).send({ error: 'not_found', message: 'Venue account not found' });
      }

      if (!venueAccount.credentialId) {
        return reply.status(409).send({ error: 'no_credential', message: 'Linked venue account has no credential' });
      }
    }

    try {
      const [updated] = await db.update(bots)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(bots.id, id), ne(bots.status, 'running')))
        .returning({ id: bots.id });

      if (!updated) {
        return reply.status(409).send({ error: 'already_running', botId: id });
      }
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return reply.status(409).send({ error: 'venue_account_conflict', message: 'Another bot is already running on this venue account' });
      }
      throw err;
    }

    await queue.add('start-instance', {
      command: 'start',
      tradingInstanceId: id,
      config: { ...bot.config, venueAccountId: bot.venueAccountId, userId: bot.userId },
    });
    return reply.send({ status: 'starting', botId: id });
  });

  // Stop a bot
  app.post<{ Params: { id: string } }>('/bots/:id/stop', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    await db.update(bots)
      .set({ status: 'stopped', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, id));

    await queue.add('stop-instance', {
      command: 'stop',
      tradingInstanceId: id,
    });
    return reply.send({ status: 'stopping', botId: id });
  });

  // Update bot config
  app.patch<{ Params: { id: string } }>('/bots/:id/config', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateInstanceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [existing] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Live-mode plan gate
    if (plansConfig) {
      const newExecutionMode = (parsed.data.config['execution'] as Record<string, unknown> | undefined)?.['mode'];
      if (newExecutionMode === 'live') {
        const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free');
        if (!liveCheck.ok) {
          return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
        }
      }
    }

    await db.update(bots)
      .set({ config: parsed.data.config, updatedAt: new Date() })
      .where(eq(bots.id, id));

    // Restart if running to pick up new config
    if (existing.status === 'running') {
      await queue.add('restart-instance', {
        command: 'restart',
        tradingInstanceId: id,
        config: { ...parsed.data.config, venueAccountId: existing.venueAccountId, userId: existing.userId },
      });
    }

    return reply.send({ status: 'updated', botId: id });
  });

  // List bots
  app.get('/bots', async (request, reply) => {
    const botList = await db.select().from(bots).where(eq(bots.userId, request.userId));
    return reply.send({ bots: botList });
  });

  // Get single bot
  app.get<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(bot);
  });
}
