import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, connections, capabilityGrants } from '@herobids/db';
import type { CapabilityReadiness, ReadinessState } from '@herobids/domain';

/**
 * Derive the aggregate readiness state for a single capability grant.
 *
 * Rules (matches the shared contract in platform.ts):
 * - connection revoked         → readiness = "revoked"
 * - grant revoked              → readiness = "revoked"
 * - connection active & grant active → "ready"
 *
 * Future: once bindings are provisioned in step 21.3 the provisioning/degraded
 * states will be set based on binding health. For now, any active grant on an
 * active connection is "ready".
 */
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

export async function readinessRoutes(app: FastifyInstance, db: Database): Promise<void> {
  /**
   * GET /agents/:agentId/capabilities/:family/readiness
   *
   * Returns the canonical shared readiness shape for the given agent + capability
   * family, aggregated across all grants for that family.
   *
   * effectiveReady is true only when at least one active grant exists on an
   * active connection for the requested capability family.
   */
  app.get<{ Params: { agentId: string; family: string } }>(
    '/agents/:agentId/capabilities/:family/readiness',
    async (request, reply) => {
      const { agentId, family } = request.params;

      // Verify agent ownership
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      // Fetch grants for this agent + family (join to connection for status)
      const rows = await db
        .select({
          grantId: capabilityGrants.id,
          grantStatus: capabilityGrants.status,
          connectionId: connections.id,
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(
          and(
            eq(capabilityGrants.agentId, agentId),
            eq(capabilityGrants.capabilityFamily, family),
          ),
        );

      if (rows.length === 0) {
        const readiness: CapabilityReadiness = {
          family,
          state: 'unconfigured',
          bindingReadiness: 'unconfigured',
          agentEligibility: 'ineligible',
          effectiveReady: false,
          reasons: ['no grants have been created for this capability family'],
        };
        return reply.send(readiness);
      }

      // Aggregate: find the best available grant
      const activeGrant = rows.find(
        (r) => r.grantStatus === 'active' && r.connectionStatus === 'active',
      );

      if (activeGrant) {
        const readiness: CapabilityReadiness = {
          family,
          state: 'ready',
          bindingReadiness: 'ready',
          agentEligibility: 'eligible',
          effectiveReady: true,
          bindingId: activeGrant.grantId,
          reasons: [],
        };
        return reply.send(readiness);
      }

      // All grants are revoked or on revoked connections
      const { state, reasons } = deriveReadiness(
        rows[0]!.grantStatus,
        rows[0]!.connectionStatus,
      );
      const readiness: CapabilityReadiness = {
        family,
        state,
        bindingReadiness: state,
        agentEligibility: 'ineligible',
        effectiveReady: false,
        bindingId: rows[0]!.grantId,
        reasons,
      };
      return reply.send(readiness);
    },
  );

  /**
   * GET /agents/:agentId/capabilities/readiness
   *
   * Returns aggregate readiness across ALL capability families for this agent.
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
          connectionId: connections.id,
          connectionStatus: connections.status,
        })
        .from(capabilityGrants)
        .innerJoin(connections, eq(capabilityGrants.connectionId, connections.id))
        .where(eq(capabilityGrants.agentId, agentId));

      // Group by family and pick best grant per family
      const byFamily = new Map<string, typeof rows>();
      for (const row of rows) {
        const existing = byFamily.get(row.capabilityFamily) ?? [];
        existing.push(row);
        byFamily.set(row.capabilityFamily, existing);
      }

      const capabilities: CapabilityReadiness[] = [];
      for (const [family, familyRows] of byFamily) {
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
          const first = familyRows[0]!;
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
}
