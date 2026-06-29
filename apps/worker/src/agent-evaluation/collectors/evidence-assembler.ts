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
import { redactJson } from '../redaction.js';

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
  /**
   * Resolved time bounds for session-scoped evaluations.
   * When provided, overrides scope-based time filter resolution.
   * Set by the orchestrator after looking up session start/stop timestamps.
   */
  sessionTimestamps?: { startedAt: Date; stoppedAt: Date };
  /** Optional Redis client for best-effort snapshot */
  redis?: { snapshot: () => Promise<Record<string, unknown>> };
}

// ── Helper ──────────────────────────────────────────────────────────────────

/**
 * Convert a ResolvedEvaluationScope into concrete time bounds for loaders.
 * Returns undefined filters for `allTime`.
 *
 * For session scope, uses the provided sessionTimestamps from the orchestrator.
 * If sessionTimestamps are not provided for a session scope, falls back to
 * no time filter (all-time) — this is a safety net, not the normal path.
 */
function scopeTimeFilter(
  scope: ResolvedEvaluationScope,
  sessionTimestamps?: { startedAt: Date; stoppedAt: Date },
): { from?: Date; to?: Date; at?: Date } | undefined {
  switch (scope.type) {
    case 'session':
      if (sessionTimestamps) {
        return {
          from: sessionTimestamps.startedAt,
          to: sessionTimestamps.stoppedAt,
          at: sessionTimestamps.stoppedAt,
        };
      }
      // Safety net: if timestamps weren't resolved, don't silently pull all data.
      // This should not happen in normal operation — the orchestrator always
      // resolves timestamps before calling the assembler.
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
  const timeFilter = scopeTimeFilter(ctx.scope, ctx.sessionTimestamps);

  // ── Fills ──────────────────────────────────────────────────────────────
  try {
    const fills = await loadAgentFills(ctx.db, ctx.agentId, timeFilter);
    const redacted = redactJson(fills);
    await ctx.store.write(ctx.runId, 'fills.json', JSON.stringify(redacted, null, 2));
    entries.push({ artifactName: 'fills.json', collected: true, itemCount: fills.length });
  } catch (err) {
    entries.push({ artifactName: 'fills.json', collected: false, error: String(err) });
  }

  // ── Journal events ─────────────────────────────────────────────────────
  try {
    const journal = await loadAgentJournalEvents(ctx.db, ctx.agentId, timeFilter);
    const redacted = redactJson(journal);
    await ctx.store.write(ctx.runId, 'journal.json', JSON.stringify(redacted, null, 2));
    entries.push({ artifactName: 'journal.json', collected: true, itemCount: journal.length });
  } catch (err) {
    entries.push({ artifactName: 'journal.json', collected: false, error: String(err) });
  }

  // ── Runtime sessions ───────────────────────────────────────────────────
  try {
    const sessions = await loadAgentRuntimeSessions(ctx.db, ctx.agentId, timeFilter);
    const redacted = redactJson(sessions);
    await ctx.store.write(ctx.runId, 'sessions.json', JSON.stringify(redacted, null, 2));
    entries.push({ artifactName: 'sessions.json', collected: true, itemCount: sessions.length });
  } catch (err) {
    entries.push({ artifactName: 'sessions.json', collected: false, error: String(err) });
  }

  // ── Positions (snapshot) ───────────────────────────────────────────────
  try {
    const at = timeFilter?.at;
    const positions = await loadAgentPositions(ctx.db, ctx.agentId, at ? { at } : {});
    const redacted = redactJson(positions);
    await ctx.store.write(ctx.runId, 'positions.json', JSON.stringify(redacted, null, 2));
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
      const redacted = redactJson(metadata);
      await ctx.store.write(ctx.runId, 'agent-metadata.json', JSON.stringify(redacted, null, 2));
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
