import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import { agents, connections, tradingBindings, capabilityGrants } from '@herobids/db';
import type { CapabilityReadiness, ReadinessState, PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { tradingCapabilityRoutes } from './trading.js';

function deriveReadiness(
  grantStatus: string,
  bindingStatus: string,
  connectionStatus: string,
): { state: ReadinessState; reasons: string[] } {
  if (connectionStatus === 'revoked') {
    return { state: 'revoked', reasons: ['underlying connection has been revoked'] };
  }
  if (bindingStatus === 'revoked') {
    return { state: 'revoked', reasons: ['binding has been revoked'] };
  }
  if (grantStatus === 'revoked') {
    return { state: 'revoked', reasons: ['grant has been revoked'] };
  }
  return { state: 'ready', reasons: [] };
}

function chooseFallbackGrant<T extends { grantedAt: Date; grantId: string }>(rows: T[]): T {
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.grantId.localeCompare(left.grantId);
  })[0]!;
}

export async function capabilityRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig: PlansConfig | undefined,
  budgets: RuntimeBudgetPolicy,
  redisClient?: Redis,
): Promise<void> {
  const knownFamilies = ['trading'] as const;

  app.get('/capabilities', async (_request, reply) => {
    return reply.send({
      families: [
        {
          family: 'trading',
          description: 'Algorithmic trading across multiple venues',
          status: 'available',
          supportedActions: ['start', 'stop', 'pause', 'resume', 'bind', 'unbind'],
        },
      ],
    });
  });

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/readiness',
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
          capabilityFamily: capabilityGrants.capabilityFamily,
          grantStatus: capabilityGrants.status,
          grantedAt: capabilityGrants.grantedAt,
          bindingId: tradingBindings.id,
          bindingStatus: tradingBindings.status,
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(tradingBindings, eq(capabilityGrants.bindingId, tradingBindings.id))
        .innerJoin(connections, eq(tradingBindings.connectionId, connections.id))
        .where(eq(capabilityGrants.agentId, agentId))
        .orderBy(desc(capabilityGrants.grantedAt), desc(capabilityGrants.id));

      const byFamily = new Map<string, typeof rows>();
      for (const row of rows) {
        const existing = byFamily.get(row.capabilityFamily) ?? [];
        existing.push(row);
        byFamily.set(row.capabilityFamily, existing);
      }

      const capabilities: CapabilityReadiness[] = [];
      for (const family of knownFamilies) {
        const familyRows = byFamily.get(family) ?? [];
        if (familyRows.length === 0) {
          capabilities.push({
            family,
            state: 'unconfigured',
            bindingReadiness: 'unconfigured',
            agentEligibility: 'ineligible',
            effectiveReady: false,
            reasons: ['no grants have been created for this capability family'],
          });
          continue;
        }

        const activeGrant = familyRows.find((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');
        if (activeGrant) {
          capabilities.push({
            family,
            state: 'ready',
            bindingReadiness: 'ready',
            agentEligibility: 'eligible',
            effectiveReady: true,
            bindingId: activeGrant.bindingId,
            reasons: [],
          });
        } else {
          const first = chooseFallbackGrant(familyRows);
          const { state, reasons } = deriveReadiness(first.grantStatus, first.bindingStatus, first.connectionStatus);
          capabilities.push({
            family,
            state,
            bindingReadiness: state,
            agentEligibility: 'ineligible',
            effectiveReady: false,
            bindingId: first.bindingId,
            reasons,
          });
        }
      }

      for (const [family, familyRows] of byFamily) {
        if (knownFamilies.includes(family as (typeof knownFamilies)[number])) {
          continue;
        }

        const activeGrant = familyRows.find((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');
        if (activeGrant) {
          capabilities.push({
            family,
            state: 'ready',
            bindingReadiness: 'ready',
            agentEligibility: 'eligible',
            effectiveReady: true,
            bindingId: activeGrant.bindingId,
            reasons: [],
          });
        } else {
          const first = chooseFallbackGrant(familyRows);
          const { state, reasons } = deriveReadiness(first.grantStatus, first.bindingStatus, first.connectionStatus);
          capabilities.push({
            family,
            state,
            bindingReadiness: state,
            agentEligibility: 'ineligible',
            effectiveReady: false,
            bindingId: first.bindingId,
            reasons,
          });
        }
      }

      return reply.send({ agentId, capabilities });
    },
  );

  await tradingCapabilityRoutes(app, db, plansConfig, budgets, redisClient);
}
