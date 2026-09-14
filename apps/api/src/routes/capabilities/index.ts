import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import { agents, connections, agentConnections, deriveReadiness, chooseLatest } from '@herobids/db';
import type { RuntimeAssignmentRow } from '@herobids/db';
import type { CapabilityReadiness, PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { getRuntimeFamiliesForProvider } from '@herobids/domain';
import type { TradertonClient } from '@herobids/domain/traderton';
import { tradingCapabilityRoutes } from './trading.js';

export async function capabilityRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig: PlansConfig | undefined,
  budgets: RuntimeBudgetPolicy,
  redisClient?: Redis,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const knownFamilies = ['trading'] as const;

  app.get('/capabilities', async (_request, reply) => {
    return reply.send({
      families: [
        {
          family: 'trading',
          description: 'Algorithmic trading across multiple venues',
          status: 'available',
          supportedActions: ['start', 'stop', 'pause', 'resume'],
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

      const rows: RuntimeAssignmentRow[] = (await db
        .select({
          assignmentId: agentConnections.id,
          grantStatus: agentConnections.status,
          grantedAt: agentConnections.grantedAt,
          connectionId: connections.id,
          connectionStatus: connections.status,
          provider: connections.provider,
          label: connections.label,
          providerRef: connections.providerRef,
          profile: connections.profile,
          resolvedVenueAccountId: connections.resolvedVenueAccountId,
        })
        .from(agentConnections)
        .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
        .where(eq(agentConnections.agentId, agentId))).map((row) => ({
          ...row,
          capabilities: getRuntimeFamiliesForProvider(row.provider),
        }));

      // Collect all families from provider capabilities across all rows
      const allFamilies = new Set<string>();
      for (const row of rows) {
        for (const cap of row.capabilities ?? []) {
          allFamilies.add(cap);
        }
      }
      // Ensure known families are always present
      for (const family of knownFamilies) {
        allFamilies.add(family);
      }

      const capabilities: CapabilityReadiness[] = [];
      for (const family of allFamilies) {
        const familyRows = rows.filter((row) => (row.capabilities ?? []).includes(family));
        const activeInFamily = familyRows.filter((row) => row.grantStatus === 'active');
        // Surface 'revoked' only when the connection itself was revoked. Removed
        // grants (PATCH connectionIds: []) should show 'unconfigured' instead.
        const connectionRevokedInFamily = familyRows.filter((row) => row.connectionStatus === 'revoked');
        const relevantRows = activeInFamily.length > 0 ? activeInFamily : connectionRevokedInFamily;
        const latest = chooseLatest(relevantRows);
        const readiness = deriveReadiness(latest, family);
        capabilities.push(readiness);
      }

      return reply.send({ agentId, capabilities });
    },
  );

  await tradingCapabilityRoutes(app, db, plansConfig, budgets, redisClient, tradertonReadClient, tradertonReadTimeoutMs);
}
