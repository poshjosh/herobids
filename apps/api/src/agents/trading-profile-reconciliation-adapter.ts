import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentConnections, connections } from '@herobids/db';
import type {
  TradingProfileAgentConfig,
  TradingProfileConnection,
  TradingProfileReconciliationPlan,
} from './trading-profile-reconciliation.js';
import { planTradingProfileReconciliation } from './trading-profile-reconciliation.js';

export interface TradingProfileReconciliationInput {
  prior: {
    config: TradingProfileAgentConfig;
    connections: TradingProfileConnection[];
  };
  proposed: {
    config: TradingProfileAgentConfig;
    connections: TradingProfileConnection[];
  };
}

export type TradingProfilePlanWriter = (plan: TradingProfileReconciliationPlan) => void | Promise<void>;

/** Loads active agent bindings in the same newest-grant-first order used for runtime selection. */
export async function loadActiveTradingProfileConnections(
  db: Pick<Database, 'select'>,
  agentId: string,
): Promise<TradingProfileConnection[]> {
  const rows = await db.select({
    assignmentId: agentConnections.id,
    grantedAt: agentConnections.grantedAt,
    connectionId: connections.id,
    venueAccountId: connections.resolvedVenueAccountId,
    connectionStatus: connections.status,
  }).from(agentConnections)
    .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
    .where(and(eq(agentConnections.agentId, agentId), eq(agentConnections.status, 'active')))
    .orderBy(desc(agentConnections.grantedAt), desc(agentConnections.id));

  return rows.map((row) => ({
    connectionId: row.connectionId,
    venueAccountId: row.venueAccountId,
    active: true,
    ready: row.connectionStatus === 'active',
    grantedAt: row.grantedAt,
    assignmentId: row.assignmentId,
  }));
}

/**
 * The sole workflow-facing reconciliation seam. C1 can install its durable
 * writer here without requiring every mutation path to reconstruct planner input.
 */
export async function reconcileTradingProfile(
  input: TradingProfileReconciliationInput,
  writePlan?: TradingProfilePlanWriter,
): Promise<TradingProfileReconciliationPlan> {
  const plan = planTradingProfileReconciliation(input);
  if (writePlan) {
    await writePlan(plan);
  }
  return plan;
}