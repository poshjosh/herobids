import { eq, and, gte, lte } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentRuntimeSessions } from './schema/index.js';

// ── Shared query filter type ─────────────────────────────────────────────────

export interface LoaderTimeFilter {
  from?: Date;
  to?: Date;
}

// ── Runtime session loaders ──────────────────────────────────────────────────

/**
 * Load runtime sessions for an agent.
 */
export async function loadAgentRuntimeSessions(
  db: Database,
  agentId: string,
  opts?: LoaderTimeFilter,
): Promise<typeof agentRuntimeSessions.$inferSelect[]> {
  return db
    .select()
    .from(agentRuntimeSessions)
    .where(and(
      eq(agentRuntimeSessions.agentId, agentId),
      ...(opts?.from ? [gte(agentRuntimeSessions.startedAt, opts.from)] : []),
      ...(opts?.to ? [lte(agentRuntimeSessions.startedAt, opts.to)] : []),
    ));
}
