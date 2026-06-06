import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, desc, sum, count, isNull } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentRuntimeSessions, agentMessages, agentArtifacts, agentOutboundMessages, decisions, bots, PgJournal, FillRepository, fills, positions, journalEvents } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { checkAgentLimit } from '../plan-guards.js';

// --- Request Schemas ---

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(4000),
  skillIds: z.array(z.string().min(1)).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
  telegramChatId: z.string().optional(),
  executionMode: z.enum(['paper', 'shadow', 'live']).optional(),
  dailyTokenBudget: z.number().int().min(1).optional(),
  dailyLossLimit: z.string().optional(),
  maxBots: z.number().int().min(1).optional(),
  maxSlippageBps: z.number().int().min(0).optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  skillIds: z.array(z.string().min(1)).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
  telegramChatId: z.string().nullable().optional(),
  // nullable allows clearing a previously set value; undefined (omitted) leaves the field unchanged
  executionMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
  dailyTokenBudget: z.number().int().min(1).nullable().optional(),
  dailyLossLimit: z.string().nullable().optional(),
  maxBots: z.number().int().min(1).nullable().optional(),
  maxSlippageBps: z.number().int().min(0).nullable().optional(),
});

const PauseAgentSchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function agentRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // --- CRUD ---

  // Create agent
  app.post('/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkAgentLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    const agentId = crypto.randomUUID();
    const now = new Date();

    // Auto-populate toolPolicy from skillIds so the broker enforces the right capability grants
    // without requiring the caller to supply raw CapabilityGrant objects.
    const basePolicy: Record<string, unknown> = { ...(parsed.data.toolPolicy ?? {}) };
    if ((parsed.data.skillIds ?? []).includes('bot-management') && !basePolicy['manage_bot']) {
      basePolicy['manage_bot'] = {
        capability: 'manage_bot',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
      };
    }
    const effectiveToolPolicy = Object.keys(basePolicy).length > 0 ? basePolicy : null;

    await db.insert(agents).values({
      id: agentId,
      userId: request.userId,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      skillIds: parsed.data.skillIds ?? [],
      status: 'stopped',
      toolPolicy: effectiveToolPolicy,
      modelPolicy: parsed.data.modelPolicy ?? null,
      telegramChatId: parsed.data.telegramChatId ?? null,
      executionMode: parsed.data.executionMode ?? null,
      dailyTokenBudget: parsed.data.dailyTokenBudget ?? null,
      dailyLossLimit: parsed.data.dailyLossLimit ?? null,
      maxBots: parsed.data.maxBots ?? null,
      maxSlippageBps: parsed.data.maxSlippageBps ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return reply.status(201).send(agent);
  });

  // List user's agents
  app.get('/agents', async (request, reply) => {
    const rows = await db.select().from(agents)
      .where(eq(agents.userId, request.userId))
      .orderBy(agents.createdAt);
    return reply.send(rows);
  });

  // Get single agent
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Include active session (starting/launching/running/unhealthy)
    const [session] = await db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, id),
        inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt));

    return reply.send({ ...agent, activeSession: session ?? null });
  });

  // Update agent
  app.patch<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Config changes are only safe when the agent is not running.
    // Mutating prompt, skills, or limits while a session is active would produce
    // inconsistent behaviour — the running process has already loaded its config.
    if (!['stopped', 'crashed'].includes(agent.status)) {
      return reply.status(409).send({
        error: 'agent_not_editable',
        message: `Agent config can only be updated when stopped or crashed (current status: ${agent.status}).`,
      });
    }

    // Re-derive toolPolicy from the effective skillIds — same logic as the create path —
    // so that capability grants stay consistent whenever skills are added or removed via PATCH.
    const mergedSkillIds = parsed.data.skillIds ?? agent.skillIds ?? [];
    // If toolPolicy is explicitly provided in the PATCH body, replace the stored policy entirely
    // (allow callers to remove overrides). If omitted, preserve the existing stored policy.
    const basePolicy: Record<string, unknown> = parsed.data.toolPolicy !== undefined
      ? { ...parsed.data.toolPolicy }
      : { ...((agent.toolPolicy as Record<string, unknown> | null) ?? {}) };
    if (mergedSkillIds.includes('bot-management') && !basePolicy['manage_bot']) {
      basePolicy['manage_bot'] = {
        capability: 'manage_bot',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
      };
    } else if (
      !mergedSkillIds.includes('bot-management') &&
      // Only auto-remove if the caller did not explicitly supply a grant entry.
      !(parsed.data.toolPolicy && 'manage_bot' in parsed.data.toolPolicy)
    ) {
      delete basePolicy['manage_bot'];
    }
    const effectiveToolPolicy = Object.keys(basePolicy).length > 0 ? basePolicy : null;

    await db.update(agents).set({
      ...parsed.data,
      toolPolicy: effectiveToolPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    return reply.send(updated);
  });

  // Delete agent
  app.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Only allow delete when stopped
    if (agent.status !== 'stopped') {
      return reply.status(409).send({ error: 'agent_not_stopped', message: 'Agent must be stopped before deletion' });
    }

    // Delete the agent — explicitly cascade-delete child rows before the parent.
    await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
    await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
    return reply.status(204).send();
  });

  // --- Lifecycle ---

  // Pause agent
  app.post<{ Params: { id: string } }>('/agents/:id/pause', async (request, reply) => {
    const { id } = request.params;
    const parsed = PauseAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Idempotent
    if (agent.status === 'paused') {
      return reply.send({ status: 'paused' });
    }

    await db.update(agents).set({
      status: 'paused',
      pauseState: { reason: parsed.data.reason, requestedBy: 'user', pausedAt: new Date().toISOString() },
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    return reply.send({ status: 'paused' });
  });

  // Resume agent
  app.post<{ Params: { id: string } }>('/agents/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (agent.status !== 'paused') {
      return reply.status(409).send({ error: 'not_paused', message: 'Agent is not paused' });
    }

    await db.update(agents).set({
      status: 'active',
      pauseState: null,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    return reply.send({ status: 'active' });
  });

  // Start agent (stopped → starting) — records the request durably.
  app.post<{ Params: { id: string } }>('/agents/:id/start', async (request, reply) => {
    const { id } = request.params;
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ status: agents.status }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) {
        return { kind: 'not_found' as const };
      }

      if (agent.status !== 'stopped') {
        return { kind: 'not_stopped' as const };
      }

      const [claimedAgent] = await tx.update(agents).set({
        status: 'starting',
        pauseState: null,
        updatedAt: now,
      }).where(and(
        eq(agents.id, id),
        eq(agents.userId, request.userId),
        eq(agents.status, 'stopped'),
      )).returning({ id: agents.id });
      if (!claimedAgent) {
        return { kind: 'not_stopped' as const };
      }

      await tx.update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(and(
          eq(agentRuntimeSessions.agentId, id),
          inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
        ));

      await tx.insert(agentRuntimeSessions).values({
        id: sessionId,
        agentId: id,
        status: 'starting',
      });

      return { kind: 'started' as const };
    });

    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (result.kind === 'not_stopped') {
      return reply.status(409).send({ error: 'not_stopped', message: 'Agent is not stopped' });
    }

    return reply.status(202).send({ status: 'starting', sessionId });
  });

  // --- Views ---

  // Get agent activity (recent messages)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/activity', async (request, reply) => {
    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '50', 10);

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const messages = await db.select().from(agentMessages)
      .where(eq(agentMessages.agentId, id))
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit);

    return reply.send(messages);
  });

  // Get agent artifacts
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/artifacts', async (request, reply) => {
    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '50', 10);

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const artifacts = await db.select().from(agentArtifacts)
      .where(eq(agentArtifacts.agentId, id))
      .orderBy(desc(agentArtifacts.createdAt))
      .limit(limit);

    return reply.send(artifacts);
  });

  // Get agent sessions history
  app.get<{ Params: { id: string } }>('/agents/:id/sessions', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const sessions = await db.select().from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.agentId, id))
      .orderBy(agentRuntimeSessions.startedAt);

    return reply.send(sessions);
  });

  // Stop agent (active/paused/starting → stopped).
  // Marks the agent and its active sessions as stopped. The worker's health monitor
  // cleans up any in-memory runtime handles on the next check cycle.
  app.post<{ Params: { id: string } }>('/agents/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return { kind: 'not_found' as const };
      if (agent.status === 'stopped') return { kind: 'already_stopped' as const };

      await tx.update(agents).set({ status: 'stopped', pauseState: null, updatedAt: now })
        .where(eq(agents.id, id));

      await tx.update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(and(
          eq(agentRuntimeSessions.agentId, id),
          inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
        ));

      return { kind: 'stopped' as const };
    });

    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    return reply.send({ status: 'stopped' });
  });

  // Get agent outbound messages (agent-authored + platform safety alerts).
  // Returns the actual content sent to the user, with authorship distinction.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; authoredBy?: string } }>('/agents/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const authoredByFilter = request.query.authoredBy;

    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const query = db.select().from(agentOutboundMessages)
      .where(
        authoredByFilter
          ? and(eq(agentOutboundMessages.agentId, id), eq(agentOutboundMessages.authoredBy, authoredByFilter))
          : eq(agentOutboundMessages.agentId, id),
      )
      .orderBy(desc(agentOutboundMessages.createdAt))
      .limit(limit);

    return reply.send(await query);
  });

  // Get agent's recent decisions submitted to the engine
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/decisions', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '10', 10), 50);

    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const rows = await db
      .select({
        id: decisions.id,
        intent: decisions.intent,
        instrumentId: decisions.instrumentId,
        targetSize: decisions.targetSize,
        limitPrice: decisions.limitPrice,
        createdAt: decisions.createdAt,
      })
      .from(decisions)
      .where(
        and(
          eq(decisions.actorType, 'agent'),
          eq(decisions.actorId, id),
        ),
      )
      .orderBy(desc(decisions.createdAt))
      .limit(limit);

    return reply.send(rows);
  });

  // GET /agents/:id/state — aggregate open positions and realized P&L across all managed bots
  app.get<{ Params: { id: string } }>('/agents/:id/state', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    // Trading data is stored under bot actors (actorType='bot', actorId=botId).
    // Resolve bot IDs created by this agent first.
    const managedBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const botIds = managedBots.map((b) => b.id);

    if (botIds.length === 0) {
      return reply.send({ agentId: id, totalPnl: '0', openPositionCount: 0, updatedAt: new Date().toISOString() });
    }

    // totalPnl: realizedPnl accumulated across ALL positions (open + closed) so it
    // reflects the agent's full trading history, not just current open exposure.
    const [pnlResult] = await db
      .select({ totalPnl: sum(positions.realizedPnl) })
      .from(positions)
      .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));

    // openPositionCount: rows that are still open (not yet closed/flat).
    const [openResult] = await db
      .select({ openCount: count(positions.id) })
      .from(positions)
      .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds), isNull(positions.closedAt)));

    const totalPnl = parseFloat(pnlResult?.totalPnl ?? '0').toFixed(6);
    const openPositionCount = openResult?.openCount ?? 0;

    return reply.send({
      agentId: id,
      totalPnl,
      openPositionCount,
      updatedAt: new Date().toISOString(),
    });
  });

  // GET /agents/:id/bots — bots created by this agent
  app.get<{ Params: { id: string } }>('/agents/:id/bots', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const agentBots = await db.select().from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));

    return reply.send({ agentId: id, bots: agentBots });
  });

  // GET /agents/:id/costs — sum fees across all managed bots
  app.get<{ Params: { id: string } }>('/agents/:id/costs', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    // Trading data is stored under bot actors — resolve managed bot IDs first.
    const managedBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const botIds = managedBots.map((b) => b.id);

    if (botIds.length === 0) {
      return reply.send({ agentId: id, feesByCurrency: {} });
    }

    // Group by feeCurrency to avoid summing across heterogeneous assets.
    const feeRows = await db
      .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
      .groupBy(fills.feeCurrency);

    const feesByCurrency: Record<string, string> = {};
    for (const row of feeRows) {
      feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
    }

    return reply.send({
      agentId: id,
      feesByCurrency,
    });
  });

  // GET /agents/:id/journal — paginated journal events across all managed bots
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; type?: string } }>('/agents/:id/journal', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    // Journal events are stored under bot actors — resolve managed bot IDs first.
    const managedBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const botIds = managedBots.map((b) => b.id);

    if (botIds.length === 0) {
      return reply.send({ agentId: id, events: [], limit, offset });
    }

    // Query directly with inArray for correct cross-bot pagination at the DB level.
    const baseConditions = [inArray(journalEvents.actorId, botIds)];
    if (request.query.type) baseConditions.push(eq(journalEvents.type, request.query.type));
    const events = await db.select().from(journalEvents)
      .where(and(...baseConditions))
      .orderBy(desc(journalEvents.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ agentId: id, events, limit, offset });
  });

  // GET /agents/:id/trades — fills across all managed bots
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>('/agents/:id/trades', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    // Fills are stored under bot actors — resolve managed bot IDs first.
    const managedBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const botIds = managedBots.map((b) => b.id);

    if (botIds.length === 0) {
      return reply.send({ agentId: id, trades: [] });
    }

    // Query directly with inArray for correct cross-bot ordering and pagination.
    const trades = await db.select().from(fills)
      .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
      .orderBy(desc(fills.filledAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ agentId: id, trades, limit, offset });
  });
}
