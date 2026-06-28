import type { Database } from '@herobids/db';
import {
  loadAgentFills,
  loadAgentJournalEvents,
  loadAgentRuntimeSessions,
  loadAgentPositions,
  AgentRepository,
  UsageBillingRepository,
} from '@herobids/db';
import type { ResolvedEvaluationScope, EvaluationArtifactStore } from '@herobids/domain';

// ── Types ───────────────────────────────────────────────────────────────────

export interface EvidenceManifestEntry {
  artifactName: string;
  collected: boolean;
  itemCount?: number;
  error?: string;
}

export interface EvidenceManifest {
  entries: EvidenceManifestEntry[];
  /** Resolved scope used for collection */
  scope: ResolvedEvaluationScope;
}

export interface EvidenceAssemblyContext {
  db: Database;
  agentId: string;
  scope: ResolvedEvaluationScope;
  store: EvaluationArtifactStore;
  runId: string;
  /** Optional Redis client for best-effort snapshot */
  redis?: { snapshot: () => Promise<Record<string, unknown>> };
}

// ── Helper ──────────────────────────────────────────────────────────────────

/**
 * Convert a ResolvedEvaluationScope into concrete time bounds for loaders.
 * Returns undefined filters for `allTime`.
 */
function scopeTimeFilter(scope: ResolvedEvaluationScope): { from?: Date; to?: Date; at?: Date } | undefined {
  switch (scope.type) {
    case 'session':
      // Session scope — the collector doesn't resolve session timestamps here;
      // that is done by the caller (run-evaluation.ts) which looks up the session.
      // For now, return undefined (all time) — the caller should pass resolved timestamps.
      return undefined;
    case 'timeRange':
      return { from: scope.from, to: scope.to, at: scope.to };
    case 'allTime':
      return undefined;
  }
}

// ── Assembler ───────────────────────────────────────────────────────────────

/**
 * Assemble all deterministic evidence for an agent evaluation run.
 *
 * Writes collected data as artifacts to the store and returns a manifest
 * listing what was collected and what failed (with reason).
 *
 * Best-effort collectors (Redis, container logs) catch and record failures
 * without aborting the entire collection.
 */
export async function assembleEvidence(ctx: EvidenceAssemblyContext): Promise<EvidenceManifest> {
  const entries: EvidenceManifestEntry[] = [];
  const timeFilter = scopeTimeFilter(ctx.scope);

  // ── Fills ──────────────────────────────────────────────────────────────
  try {
    const fills = await loadAgentFills(ctx.db, ctx.agentId, timeFilter);
    await ctx.store.write(ctx.runId, 'fills.json', JSON.stringify(fills, null, 2));
    entries.push({ artifactName: 'fills.json', collected: true, itemCount: fills.length });
  } catch (err) {
    entries.push({ artifactName: 'fills.json', collected: false, error: String(err) });
  }

  // ── Journal events ─────────────────────────────────────────────────────
  try {
    const journal = await loadAgentJournalEvents(ctx.db, ctx.agentId, timeFilter);
    await ctx.store.write(ctx.runId, 'journal.json', JSON.stringify(journal, null, 2));
    entries.push({ artifactName: 'journal.json', collected: true, itemCount: journal.length });
  } catch (err) {
    entries.push({ artifactName: 'journal.json', collected: false, error: String(err) });
  }

  // ── Runtime sessions ───────────────────────────────────────────────────
  try {
    const sessions = await loadAgentRuntimeSessions(ctx.db, ctx.agentId, timeFilter);
    await ctx.store.write(ctx.runId, 'sessions.json', JSON.stringify(sessions, null, 2));
    entries.push({ artifactName: 'sessions.json', collected: true, itemCount: sessions.length });
  } catch (err) {
    entries.push({ artifactName: 'sessions.json', collected: false, error: String(err) });
  }

  // ── Positions (snapshot) ───────────────────────────────────────────────
  try {
    const at = timeFilter?.at;
    const positions = await loadAgentPositions(ctx.db, ctx.agentId, at ? { at } : {});
    await ctx.store.write(ctx.runId, 'positions.json', JSON.stringify(positions, null, 2));
    entries.push({ artifactName: 'positions.json', collected: true, itemCount: positions.length });
  } catch (err) {
    entries.push({ artifactName: 'positions.json', collected: false, error: String(err) });
  }

  // ── Agent metadata ─────────────────────────────────────────────────────
  try {
    const agentRepo = new AgentRepository(ctx.db);
    const agent = await agentRepo.getAgent(ctx.agentId);
    if (agent) {
      const metadata = {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        style: agent.style,
        executionMode: agent.executionMode,
        dailyLossLimit: agent.dailyLossLimit,
        maxBots: agent.maxBots,
        maxSlippageBps: agent.maxSlippageBps,
        createdAt: agent.createdAt,
      };
      await ctx.store.write(ctx.runId, 'agent-metadata.json', JSON.stringify(metadata, null, 2));
      entries.push({ artifactName: 'agent-metadata.json', collected: true });
    } else {
      entries.push({ artifactName: 'agent-metadata.json', collected: false, error: 'Agent not found' });
    }
  } catch (err) {
    entries.push({ artifactName: 'agent-metadata.json', collected: false, error: String(err) });
  }

  // ── Cost data (best-effort) ────────────────────────────────────────────
  try {
    const billingRepo = new UsageBillingRepository(ctx.db);
    // Note: getUsageSummary requires an accountId, not an agentId.
    // Agent-level cost data collection is a best-effort placeholder for Level 1.
    // Future: query billingUsageEvents by agentId directly.
    entries.push({ artifactName: 'costs.json', collected: false, error: 'Agent-level cost collection not yet implemented' });
  } catch (err) {
    entries.push({ artifactName: 'costs.json', collected: false, error: String(err) });
  }

  // ── Redis snapshot (best-effort) ───────────────────────────────────────
  if (ctx.redis) {
    try {
      const snapshot = await ctx.redis.snapshot();
      await ctx.store.write(ctx.runId, 'redis-snapshot.json', JSON.stringify(snapshot, null, 2));
      entries.push({ artifactName: 'redis-snapshot.json', collected: true });
    } catch (err) {
      entries.push({ artifactName: 'redis-snapshot.json', collected: false, error: String(err) });
    }
  }

  return { entries, scope: ctx.scope };
}
