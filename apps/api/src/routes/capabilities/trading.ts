import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { eq, and, desc, inArray, isNull, sum, count } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  agents,
  connections,
  capabilityGrants,
  bots,
  fills,
  journalEvents,
  positions,
  agentRuntimeSessions,
} from '@herobids/db';
import type { CapabilityReadiness, ReadinessState, PlansConfig } from '@herobids/domain';
import { z } from 'zod';
import {
  createGrant,
  revokeGrant,
  getGrantAudit,
  assertConnectionOwnership,
  assertGrantOwnership,
} from '../grant-service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Supported action names — honest mapping to current backend semantics.
// start/stop/pause/resume are wrappers around current agent lifecycle primitives.
// They will become capability-specific execution operations in Step 21.4.
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_ACTIONS = ['start', 'stop', 'pause', 'resume', 'bind', 'unbind'] as const;
type TradingAction = typeof SUPPORTED_ACTIONS[number];

const BindActionSchema = z.object({
  connectionId: z.string().min(1),
});

const UnbindActionSchema = z.object({
  bindingId: z.string().min(1),
});

const PauseActionSchema = z.object({
  reason: z.string().min(1).max(500),
});

const MAX_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_OFFSET = 500;
const MAX_ACTIVITY_WINDOW = 700;

const TradingActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_ACTIVITY_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_ACTIVITY_OFFSET).default(0),
});

function chooseFallbackGrant<T extends { grantedAt: Date; grantId: string }>(rows: T[]): T {
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.grantId.localeCompare(left.grantId);
  })[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness helper — identical logic to readiness.ts, kept local so the
// capability module is self-contained and readable.
// ─────────────────────────────────────────────────────────────────────────────

function deriveReadiness(
  grantStatus: string,
  connectionStatus: string,
): { state: ReadinessState; reasons: string[] } {
  if (connectionStatus === 'revoked') {
    return { state: 'revoked', reasons: ['underlying connection has been revoked'] };
  }
  if (grantStatus === 'revoked') {
    return { state: 'revoked', reasons: ['grant has been revoked'] };
  }
  return { state: 'ready', reasons: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route registrar
// ─────────────────────────────────────────────────────────────────────────────

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig?: PlansConfig,
): Promise<void> {

  // ── Family-level routes ───────────────────────────────────────────────────

  /**
   * GET /capabilities/trading
   * Returns trading family metadata.
   */
  app.get('/capabilities/trading', async (_request, reply) => {
    return reply.send({
      family: 'trading',
      description: 'Algorithmic trading across multiple venues',
      status: 'available',
      supportedActions: [...SUPPORTED_ACTIONS],
      providers: ['hyperliquid', 'jupiter', '1inch'],
      readinessStates: ['unconfigured', 'provisioning', 'ready', 'degraded', 'revoked'],
    });
  });

  /**
   * GET /capabilities/trading/providers
   * Returns trading providers derived from the current infrastructure.
   */
  app.get('/capabilities/trading/providers', async (_request, reply) => {
    return reply.send({
      providers: [
        { provider: 'hyperliquid', type: 'perpetuals', status: 'available' },
        { provider: 'jupiter', type: 'swap', status: 'available' },
        { provider: '1inch', type: 'swap', status: 'available' },
      ],
    });
  });

  /**
   * GET /capabilities/trading/bindings
   * Returns the current user's trading bindings.
   */
  app.get('/capabilities/trading/bindings', async (request, reply) => {
    const rows = await db
      .select({
        grant: capabilityGrants,
        connection: {
          id: connections.id,
          provider: connections.provider,
          label: connections.label,
          status: connections.status,
        },
      })
      .from(capabilityGrants)
      .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
      .where(and(eq(connections.userId, request.userId), eq(capabilityGrants.capabilityFamily, 'trading')));

    const bindings = rows.map((row) => ({
      bindingId: row.grant.id,
      connectionId: row.connection.id,
      provider: row.connection.provider,
      label: row.connection.label,
      connectionStatus: row.connection.status,
      status: row.grant.status,
      family: 'trading',
      grantedAt: row.grant.grantedAt.toISOString(),
      revokedAt: row.grant.revokedAt?.toISOString() ?? null,
    }));

    return reply.send({ family: 'trading', bindings });
  });

  // ── Agent-scoped routes ───────────────────────────────────────────────────

  /**
   * GET /agents/:agentId/capabilities/trading
   * Top-level trading capability view for the agent.
   */
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantRows = await db
        .select({
          grantId: capabilityGrants.id,
          grantStatus: capabilityGrants.status,
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(
          and(
            eq(capabilityGrants.agentId, agentId),
            eq(capabilityGrants.capabilityFamily, 'trading'),
          ),
        );

      const effectiveReady = grantRows.some(
        (r) => r.grantStatus === 'active' && r.connectionStatus === 'active',
      );

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        effectiveReady,
        supportedActions: [...SUPPORTED_ACTIONS],
      });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/state
   * Agent-scoped trading state: aggregate positions and realized P&L across all
   * managed bots. Temporary projection over bot actors — Step 21.3 will introduce
   * direct agent-scoped execution records.
   */
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/state',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const managedBots = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)));
      const botIds = managedBots.map((b) => b.id);

      if (botIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          agentStatus: agent.status,
          totalPnl: '0',
          openPositionCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const [pnlResult] = await db
        .select({ totalPnl: sum(positions.realizedPnl) })
        .from(positions)
        .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));

      const [openResult] = await db
        .select({ openCount: count(positions.id) })
        .from(positions)
        .where(
          and(
            eq(positions.actorType, 'bot'),
            inArray(positions.actorId, botIds),
            isNull(positions.closedAt),
          ),
        );

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        totalPnl: parseFloat(pnlResult?.totalPnl ?? '0').toFixed(6),
        openPositionCount: openResult?.openCount ?? 0,
        updatedAt: new Date().toISOString(),
      });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/readiness
   * Canonical readiness contract for the trading capability on this agent.
   * Moved from readiness.ts into the capability registration model.
   */
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/readiness',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await db
        .select({
          grantId: capabilityGrants.id,
          grantStatus: capabilityGrants.status,
          grantedAt: capabilityGrants.grantedAt,
          connectionId: connections.id,
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(
          and(
            eq(capabilityGrants.agentId, agentId),
            eq(capabilityGrants.capabilityFamily, 'trading'),
          ),
        );

      if (rows.length === 0) {
        const readiness: CapabilityReadiness = {
          family: 'trading',
          state: 'unconfigured',
          bindingReadiness: 'unconfigured',
          agentEligibility: 'ineligible',
          effectiveReady: false,
          reasons: ['no grants have been created for this capability family'],
        };
        return reply.send(readiness);
      }

      const activeGrant = rows.find(
        (r) => r.grantStatus === 'active' && r.connectionStatus === 'active',
      );

      if (activeGrant) {
        const readiness: CapabilityReadiness = {
          family: 'trading',
          state: 'ready',
          bindingReadiness: 'ready',
          agentEligibility: 'eligible',
          effectiveReady: true,
          bindingId: activeGrant.grantId,
          reasons: [],
        };
        return reply.send(readiness);
      }

        const first = chooseFallbackGrant(rows);
        const { state, reasons } = deriveReadiness(first.grantStatus, first.connectionStatus);
      const readiness: CapabilityReadiness = {
        family: 'trading',
        state,
        bindingReadiness: state,
        agentEligibility: 'ineligible',
        effectiveReady: false,
          bindingId: first.grantId,
        reasons,
      };
      return reply.send(readiness);
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/bindings
   * Agent's effective trading bindings — grants projected into the binding model.
   */
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await db
        .select({
          grant: capabilityGrants,
          connection: {
            id: connections.id,
            provider: connections.provider,
            label: connections.label,
            status: connections.status,
          },
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(
          and(
            eq(capabilityGrants.agentId, agentId),
            eq(capabilityGrants.capabilityFamily, 'trading'),
          ),
        );

      const bindings = rows.map((r) => ({
        bindingId: r.grant.id,
        connectionId: r.connection.id,
        provider: r.connection.provider,
        label: r.connection.label,
        connectionStatus: r.connection.status,
        status: r.grant.status,
        grantedAt: r.grant.grantedAt.toISOString(),
        revokedAt: r.grant.revokedAt?.toISOString() ?? null,
        family: 'trading',
      }));

      return reply.send({ agentId, family: 'trading', bindings });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/bindings/:bindingId
   * Single binding inspection.
   */
  app.get<{ Params: { agentId: string; bindingId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings/:bindingId',
    async (request, reply) => {
      const { agentId, bindingId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantWithConn = await assertGrantOwnership(db, bindingId, request.userId);
      if (
        !grantWithConn ||
        grantWithConn.agentId !== agentId ||
        grantWithConn.capabilityFamily !== 'trading'
      ) {
        return reply.status(404).send({ error: 'binding.not_found' });
      }

      return reply.send({
        bindingId: grantWithConn.id,
        connectionId: grantWithConn.connectionId,
        provider: grantWithConn.connection.provider,
        label: grantWithConn.connection.label,
        connectionStatus: grantWithConn.connection.status,
        status: grantWithConn.status,
        grantedAt: grantWithConn.grantedAt.toISOString(),
        revokedAt: grantWithConn.revokedAt?.toISOString() ?? null,
        family: 'trading',
      });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/bindings/:bindingId/audit
   * Full audit trail for a binding.
   */
  app.get<{ Params: { agentId: string; bindingId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings/:bindingId/audit',
    async (request, reply) => {
      const { agentId, bindingId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const grantWithConn = await assertGrantOwnership(db, bindingId, request.userId);
      if (
        !grantWithConn ||
        grantWithConn.agentId !== agentId ||
        grantWithConn.capabilityFamily !== 'trading'
      ) {
        return reply.status(404).send({ error: 'binding.not_found' });
      }

      const auditEntries = await getGrantAudit(db, bindingId);
      return reply.send({ bindingId, audit: auditEntries });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/activity
   * Trading activity stream: fills + operational journal events, aggregated
   * across all managed bots. Temporary projection — Step 21.3 will introduce
   * agent-scoped activity records.
   */
  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/agents/:agentId/capabilities/trading/activity',
    async (request, reply) => {
      const { agentId } = request.params;
      const queryResult = TradingActivityQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      const { limit, offset } = queryResult.data;
      const fetchCount = Math.min(limit + offset, MAX_ACTIVITY_WINDOW);

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const managedBots = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)));
      const botIds = managedBots.map((b) => b.id);

      if (botIds.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const [recentFills, recentEvents] = await Promise.all([
        db
          .select()
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
          .orderBy(desc(fills.filledAt))
          .limit(fetchCount),
        db
          .select()
          .from(journalEvents)
          .where(inArray(journalEvents.actorId, botIds))
          .orderBy(desc(journalEvents.createdAt))
          .limit(fetchCount),
      ]);

      const fillItems = recentFills.map((f) => ({
        type: 'fill' as const,
        id: f.id,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: f.price,
        fee: f.fee ?? null,
        feeCurrency: f.feeCurrency ?? null,
        venueRefId: f.venueRefId ?? null,
        timestamp: f.filledAt.toISOString(),
      }));

      const eventItems = recentEvents.map((e) => ({
        type: 'event' as const,
        id: e.id,
        eventType: e.type,
        payload: e.payload,
        timestamp: e.createdAt.toISOString(),
      }));

      // Merge and sort by timestamp descending, then slice to limit.
      const items = [...fillItems, ...eventItems]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(offset, offset + limit);

      return reply.send({ agentId, family: 'trading', items, limit, offset });
    },
  );

  /**
   * GET /agents/:agentId/capabilities/trading/outcomes
   * Trading outcomes and performance summaries for the agent.
   */
  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/outcomes',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const managedBots = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)));
      const botIds = managedBots.map((b) => b.id);

      if (botIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          tradeCount: 0,
          totalPnl: '0',
          winRate: null,
          feesByCurrency: {},
          openPositionCount: 0,
        });
      }

      const [fillCountResult, feeRows, pnlResult, openResult, allPositions] = await Promise.all([
        db
          .select({ tradeCount: count(fills.id) })
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds))),
        db
          .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
          .groupBy(fills.feeCurrency),
        db
          .select({ totalPnl: sum(positions.realizedPnl) })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds))),
        db
          .select({ openCount: count(positions.id) })
          .from(positions)
          .where(
            and(
              eq(positions.actorType, 'bot'),
              inArray(positions.actorId, botIds),
              isNull(positions.closedAt),
            ),
          ),
        db
          .select({ realizedPnl: positions.realizedPnl, closedAt: positions.closedAt })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds))),
      ]);

      const feesByCurrency: Record<string, string> = {};
      for (const row of feeRows) {
        feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
      }

      const closed = allPositions.filter((p) => p.closedAt !== null);
      const winRate =
        closed.length >= 2
          ? closed.filter((p) => parseFloat(p.realizedPnl) > 0).length / closed.length
          : null;

      return reply.send({
        agentId,
        family: 'trading',
        tradeCount: fillCountResult[0]?.tradeCount ?? 0,
        totalPnl: parseFloat(pnlResult[0]?.totalPnl ?? '0').toFixed(6),
        winRate,
        feesByCurrency,
        openPositionCount: openResult[0]?.openCount ?? 0,
      });
    },
  );

  /**
   * POST /agents/:agentId/capabilities/trading/actions/:action
   *
   * Single mutating entry point for all trading capability operations.
   *
   * Supported actions:
   * - start   → transition agent stopped → starting (wrapper around agent lifecycle)
   * - stop    → transition agent to stopped
   * - pause   → transition agent to paused (requires { reason })
   * - resume  → transition agent paused → active
   * - bind    → create a trading capability grant (requires { connectionId })
   * - unbind  → revoke an existing trading binding (requires { bindingId })
   *
   * NOTE: start/stop/pause/resume are honest wrappers around current agent lifecycle
   * primitives. They become capability-specific execution operations in Step 21.4.
   */
  app.post<{ Params: { agentId: string; action: string } }>(
    '/agents/:agentId/capabilities/trading/actions/:action',
    async (request, reply) => {
      const { agentId, action } = request.params;

      if (!SUPPORTED_ACTIONS.includes(action as TradingAction)) {
        return reply.status(400).send({
          error: 'action.unsupported',
          message: `Unsupported action "${action}". Supported: ${SUPPORTED_ACTIONS.join(', ')}`,
        });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      // ── start ────────────────────────────────────────────────────────────────
      if (action === 'start') {
        const sessionId = crypto.randomUUID();
        const now = new Date();

        const result = await db.transaction(async (tx) => {
          if (agent.status !== 'stopped') {
            return { kind: 'not_stopped' as const };
          }

          const [claimed] = await tx
            .update(agents)
            .set({ status: 'starting', pauseState: null, updatedAt: now })
            .where(
              and(
                eq(agents.id, agentId),
                eq(agents.userId, request.userId),
                eq(agents.status, 'stopped'),
              ),
            )
            .returning({ id: agents.id });

          if (!claimed) {
            return { kind: 'not_stopped' as const };
          }

          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, [
                  'starting',
                  'launching',
                  'running',
                  'unhealthy',
                ]),
              ),
            );

          await tx.insert(agentRuntimeSessions).values({
            id: sessionId,
            agentId,
            status: 'starting',
          });

          return { kind: 'started' as const };
        });

        if (result.kind === 'not_stopped') {
          return reply.status(409).send({
            error: 'agent.not_stopped',
            message: 'Agent is not stopped',
          });
        }

        return reply
          .status(202)
          .send({ action: 'start', agentId, status: 'starting', sessionId });
      }

      // ── stop ─────────────────────────────────────────────────────────────────
      if (action === 'stop') {
        const now = new Date();

        await db.transaction(async (tx) => {
          await tx
            .update(agents)
            .set({ status: 'stopped', pauseState: null, updatedAt: now })
            .where(eq(agents.id, agentId));

          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, [
                  'starting',
                  'launching',
                  'running',
                  'unhealthy',
                ]),
              ),
            );
        });

        return reply.send({ action: 'stop', agentId, status: 'stopped' });
      }

      // ── pause ────────────────────────────────────────────────────────────────
      if (action === 'pause') {
        const parsed = PauseActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: 'validation_error', details: parsed.error.issues });
        }

        if (agent.status === 'paused') {
          return reply.send({ action: 'pause', agentId, status: 'paused' });
        }

        await db
          .update(agents)
          .set({
            status: 'paused',
            pauseState: {
              reason: parsed.data.reason,
              requestedBy: 'user',
              pausedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));

        return reply.send({ action: 'pause', agentId, status: 'paused' });
      }

      // ── resume ───────────────────────────────────────────────────────────────
      if (action === 'resume') {
        if (agent.status !== 'paused') {
          return reply.status(409).send({
            error: 'agent.not_paused',
            message: 'Agent is not paused',
          });
        }

        await db
          .update(agents)
          .set({ status: 'active', pauseState: null, updatedAt: new Date() })
          .where(eq(agents.id, agentId));

        return reply.send({ action: 'resume', agentId, status: 'active' });
      }

      // ── bind ──────────────────────────────────────────────────────────────────
      if (action === 'bind') {
        const parsed = BindActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: 'validation_error', details: parsed.error.issues });
        }

        const conn = await assertConnectionOwnership(db, parsed.data.connectionId, request.userId);
        if (!conn) {
          return reply.status(400).send({
            error: 'connection.not_found',
            message: `Connection ${parsed.data.connectionId} does not exist`,
          });
        }
        if (conn.status === 'revoked') {
          return reply.status(409).send({ error: 'connection.revoked' });
        }

        let grantId: string;
        try {
          grantId = await createGrant(db, {
            agentId,
            connectionId: parsed.data.connectionId,
            capabilityFamily: 'trading',
            grantedBy: request.userId,
          });
        } catch (err: unknown) {
          const pgErr = err as { code?: string };
          if (pgErr.code === '23505') {
            return reply.status(409).send({ error: 'binding.duplicate' });
          }
          throw err;
        }

        const [grant] = await db
          .select()
          .from(capabilityGrants)
          .where(eq(capabilityGrants.id, grantId));

        return reply.status(201).send({
          action: 'bind',
          bindingId: grantId,
          agentId,
          connectionId: parsed.data.connectionId,
          family: 'trading',
          status: grant?.status ?? 'active',
          grantedAt: grant?.grantedAt.toISOString(),
        });
      }

      // ── unbind ────────────────────────────────────────────────────────────────
      if (action === 'unbind') {
        const parsed = UnbindActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: 'validation_error', details: parsed.error.issues });
        }

        const grantWithConn = await assertGrantOwnership(db, parsed.data.bindingId, request.userId);
        if (
          !grantWithConn ||
          grantWithConn.agentId !== agentId ||
          grantWithConn.capabilityFamily !== 'trading'
        ) {
          return reply.status(404).send({ error: 'binding.not_found' });
        }

        const revoked = await revokeGrant(db, {
          grantId: parsed.data.bindingId,
          actorType: 'user',
          actorId: request.userId,
        });

        if (!revoked) {
          return reply.status(409).send({ error: 'binding.already_revoked' });
        }

        return reply.send({
          action: 'unbind',
          bindingId: parsed.data.bindingId,
          agentId,
          status: 'revoked',
        });
      }

      // Unreachable — every supported action is handled above.
      return reply.status(500).send({ error: 'internal.unhandled_action' });
    },
  );
}
