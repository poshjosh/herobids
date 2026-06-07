import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, connections, capabilityGrants } from '@herobids/db';
import type { CapabilityReadiness, ReadinessState, PlansConfig } from '@herobids/domain';
import { tradingCapabilityRoutes } from './trading.js';

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

function chooseFallbackGrant<T extends { grantedAt: Date; grantId: string }>(rows: T[]): T {
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.grantId.localeCompare(left.grantId);
  })[0]!;
}

/**
 * Capability route registrar.
 *
 * Owns:
 * - GET /capabilities                          — namespace catalog
 * - GET /agents/:agentId/capabilities/readiness — aggregate readiness
 *
 * Delegates family-specific routes to family registrars.
 */
export async function capabilityRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
): Promise<void> {
  const knownFamilies = ['trading'] as const;

  /**
   * GET /capabilities
   * Returns available capability families.
   */
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

  /**
   * GET /agents/:agentId/capabilities/readiness
   * Aggregate readiness across ALL capability families for this agent.
   * Useful for the frontend mission-control surface.
   */
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
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .orderBy(desc(capabilityGrants.grantedAt), desc(capabilityGrants.id))
        .where(eq(capabilityGrants.agentId, agentId));

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

        const activeGrant = familyRows.find(
          (r) => r.grantStatus === 'active' && r.connectionStatus === 'active',
        );
        if (activeGrant) {
          capabilities.push({
            family,
            state: 'ready',
            bindingReadiness: 'ready',
            agentEligibility: 'eligible',
            effectiveReady: true,
            bindingId: activeGrant.grantId,
            reasons: [],
          });
        } else {
          const first = chooseFallbackGrant(familyRows);
          const { state, reasons } = deriveReadiness(first.grantStatus, first.connectionStatus);
          capabilities.push({
            family,
            state,
            bindingReadiness: state,
            agentEligibility: 'ineligible',
            effectiveReady: false,
            bindingId: first.grantId,
            reasons,
          });
        }
      }

      for (const [family, familyRows] of byFamily) {
        if (knownFamilies.includes(family as (typeof knownFamilies)[number])) {
          continue;
        }

        const activeGrant = familyRows.find(
          (r) => r.grantStatus === 'active' && r.connectionStatus === 'active',
        );
        if (activeGrant) {
          capabilities.push({
            family,
            state: 'ready',
            bindingReadiness: 'ready',
            agentEligibility: 'eligible',
            effectiveReady: true,
            bindingId: activeGrant.grantId,
            reasons: [],
          });
        } else {
          const first = chooseFallbackGrant(familyRows);
          const { state, reasons } = deriveReadiness(first.grantStatus, first.connectionStatus);
          capabilities.push({
            family,
            state,
            bindingReadiness: state,
            agentEligibility: 'ineligible',
            effectiveReady: false,
            bindingId: first.grantId,
            reasons,
          });
        }
      }

      return reply.send({ agentId, capabilities });
    },
  );

  // Delegate to family-specific registrars.
  await tradingCapabilityRoutes(app, db, plansConfig);
}
