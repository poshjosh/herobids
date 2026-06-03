import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentInstanceLinks, agentRuntimeSessions, tradingInstances, agentMessages, agentArtifacts, agentOutboundMessages, decisions } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { checkAgentLimit } from '../plan-guards.js';

/**
 * V1 preset registry — resolved server-side at create time.
 * The preset name is stored on the agent record. Defaults bundle tool policy and framing.
 */
const PRESET_IDS = ['momentum_trader', 'range_trader', 'dca_accumulator'] as const;
type PresetId = typeof PRESET_IDS[number];

const PRESET_DEFAULTS: Record<PresetId, { description: string; toolPolicy: Record<string, unknown> }> = {
  momentum_trader: {
    description: 'Momentum and trend-following strategy',
    toolPolicy: { decision_submit: { enabled: true }, send_message: { enabled: true, maxPerMinute: 5 } },
  },
  range_trader: {
    description: 'Range and mean-reversion strategy',
    toolPolicy: { decision_submit: { enabled: true }, send_message: { enabled: true, maxPerMinute: 5 } },
  },
  dca_accumulator: {
    description: 'DCA and position accumulation strategy',
    toolPolicy: { decision_submit: { enabled: true }, send_message: { enabled: true, maxPerMinute: 3 } },
  },
};

// --- Request Schemas ---

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(1000),
  tradingInstanceId: z.string().min(1),
  preset: z.enum(PRESET_IDS).default('momentum_trader'),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(1000).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
});

const PauseAgentSchema = z.object({
  reason: z.string().min(1).max(500),
});

const LinkInstanceSchema = z.object({
  tradingInstanceId: z.string().min(1),
});

export async function agentRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // --- CRUD ---

  // Create agent + link to a trading instance in one flow
  app.post('/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Verify user owns the trading instance
    const [instance] = await db.select({ id: tradingInstances.id })
      .from(tradingInstances)
      .where(and(eq(tradingInstances.id, parsed.data.tradingInstanceId), eq(tradingInstances.userId, request.userId)));
    if (!instance) {
      return reply.status(404).send({ error: 'not_found', message: 'Trading instance not found or not owned by user' });
    }

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkAgentLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send({ error: planCheck.error.code, message: planCheck.error.message });
      }
    }

    const agentId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const now = new Date();

    // Merge preset-default tool policy with any user-supplied overrides.
    // Preset defaults are applied first; explicit toolPolicy in the request wins.
    const presetDefaults = PRESET_DEFAULTS[parsed.data.preset];
    const mergedToolPolicy = parsed.data.toolPolicy
      ? { ...presetDefaults.toolPolicy, ...parsed.data.toolPolicy }
      : presetDefaults.toolPolicy;

    await db.insert(agents).values({
      id: agentId,
      userId: request.userId,
      name: parsed.data.name,
      goal: parsed.data.goal,
      preset: parsed.data.preset,
      status: 'stopped',
      toolPolicy: mergedToolPolicy,
      modelPolicy: parsed.data.modelPolicy ?? null,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agentInstanceLinks).values({
      id: linkId,
      agentId,
      tradingInstanceId: parsed.data.tradingInstanceId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return reply.status(201).send({ ...agent, linkedInstanceId: parsed.data.tradingInstanceId });
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

    // Include active link
    const [link] = await db.select().from(agentInstanceLinks)
      .where(and(eq(agentInstanceLinks.agentId, id), eq(agentInstanceLinks.status, 'active')));

    // Include active session — scoped to the active link's instance so a stale session
    // from a previous link is never surfaced. Shows starting/unhealthy too so the client
    // can see the session immediately after /start (before the first heartbeat).
    const [session] = link
      ? await db.select().from(agentRuntimeSessions)
          .where(and(
            eq(agentRuntimeSessions.agentId, id),
            eq(agentRuntimeSessions.tradingInstanceId, link.tradingInstanceId),
            inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
          ))
          .orderBy(desc(agentRuntimeSessions.startedAt))
      : [];

    return reply.send({
      ...agent,
      activeLink: link ?? null,
      activeSession: session ?? null,
    });
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

    await db.update(agents).set({
      ...parsed.data,
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

    // Delete FK-referencing child rows before removing the parent so PG doesn't reject.
    // Order matters: outbound messages → artifacts → sessions → links → agent
    await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
    await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
    await db.delete(agentInstanceLinks).where(eq(agentInstanceLinks.agentId, id));

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

      // An active link is required so we know which trading instance to attach the session to.
      const [activeLink] = await tx.select({ tradingInstanceId: agentInstanceLinks.tradingInstanceId }).from(agentInstanceLinks)
        .where(and(eq(agentInstanceLinks.agentId, id), eq(agentInstanceLinks.status, 'active')));
      if (!activeLink) {
        return { kind: 'no_active_link' as const };
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
          inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
        ));

      await tx.insert(agentRuntimeSessions).values({
        id: sessionId,
        agentId: id,
        tradingInstanceId: activeLink.tradingInstanceId,
        status: 'starting',
      });

      return { kind: 'started' as const };
    });

    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (result.kind === 'no_active_link') {
      return reply.status(409).send({ error: 'no_active_link', message: 'Agent has no active trading instance link' });
    }

    if (result.kind === 'not_stopped') {
      return reply.status(409).send({ error: 'not_stopped', message: 'Agent is not stopped' });
    }

    return reply.status(202).send({ status: 'starting', sessionId });
  });

  // --- Linking ---

  // Link agent to a (different) trading instance
  app.post<{ Params: { id: string } }>('/agents/:id/link', async (request, reply) => {
    const { id } = request.params;
    const parsed = LinkInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Verify user owns the target instance.
      const [instance] = await tx.select({ id: tradingInstances.id })
        .from(tradingInstances)
        .where(and(eq(tradingInstances.id, parsed.data.tradingInstanceId), eq(tradingInstances.userId, request.userId)));
      if (!instance) {
        return { kind: 'instance_not_found' as const };
      }

      const [existingLink] = await tx.select().from(agentInstanceLinks)
        .where(and(eq(agentInstanceLinks.agentId, id), eq(agentInstanceLinks.status, 'active')));

      // Re-linking to the current instance is a no-op; do not revoke the link or stop the runtime.
      if (existingLink?.tradingInstanceId === parsed.data.tradingInstanceId) {
        return { kind: 'unchanged' as const, linkId: existingLink.id };
      }

      if (existingLink) {
        await tx.update(agentInstanceLinks).set({ status: 'revoked', updatedAt: now })
          .where(eq(agentInstanceLinks.id, existingLink.id));
        await tx.update(agentRuntimeSessions)
          .set({ status: 'stopped', stoppedAt: now })
          .where(and(
            eq(agentRuntimeSessions.agentId, id),
            eq(agentRuntimeSessions.tradingInstanceId, existingLink.tradingInstanceId),
            inArray(agentRuntimeSessions.status, ['starting', 'running', 'unhealthy']),
          ));
      }

      // Relinking invalidates the previous runtime lifecycle. Force the agent back to
      // a recoverable stopped state so the next /start is well-defined on the new link.
      await tx.update(agents).set({ status: 'stopped', pauseState: null, updatedAt: now })
        .where(eq(agents.id, id));

      const linkId = crypto.randomUUID();
      await tx.insert(agentInstanceLinks).values({
        id: linkId,
        agentId: id,
        tradingInstanceId: parsed.data.tradingInstanceId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });

      return { kind: 'linked' as const, linkId };
    });

    if (result.kind === 'instance_not_found') {
      return reply.status(404).send({ error: 'not_found', message: 'Trading instance not found' });
    }

    if (result.kind === 'unchanged') {
      return reply.send({ id: result.linkId, tradingInstanceId: parsed.data.tradingInstanceId, status: 'active' });
    }

    return reply.status(201).send({ id: result.linkId, tradingInstanceId: parsed.data.tradingInstanceId, status: 'active' });
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

    // Get the agent's linked instance to find messages
    const [link] = await db.select().from(agentInstanceLinks)
      .where(and(eq(agentInstanceLinks.agentId, id), eq(agentInstanceLinks.status, 'active')));
    if (!link) {
      return reply.send([]);
    }

    const messages = await db.select().from(agentMessages)
      .where(and(
        eq(agentMessages.tradingInstanceId, link.tradingInstanceId),
        eq(agentMessages.actorId, id),
      ))
      .orderBy(agentMessages.createdAt)
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

    const [link] = await db.select({ tradingInstanceId: agentInstanceLinks.tradingInstanceId })
      .from(agentInstanceLinks)
      .where(and(eq(agentInstanceLinks.agentId, id), eq(agentInstanceLinks.status, 'active')));
    if (!link) return reply.send([]);

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
          eq(decisions.tradingInstanceId, link.tradingInstanceId),
          eq(decisions.actorType, 'agent'),
          eq(decisions.actorId, id),
        ),
      )
      .orderBy(desc(decisions.createdAt))
      .limit(limit);

    return reply.send(rows);
  });
}
