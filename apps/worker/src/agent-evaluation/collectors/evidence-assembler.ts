import type { Database } from '@herobids/db';
import {
  loadAgentFills,
  loadAgentJournalEvents,
  loadAgentRuntimeSessions,
  loadAgentPositions,
  loadAgentBotIds,
  AgentRepository,
  billingUsageEvents,
} from '@herobids/db';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { ResolvedEvaluationScope, EvaluationArtifactStore } from '@herobids/domain';
import { collectContainerLogs } from './container-logs.js';

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
 * Writes raw evidence as artifacts to the store and returns a manifest
 * listing what was collected and what failed (with reason).
 *
 * Core evidence (fills, journal, sessions, positions) must succeed —
 * failure throws and aborts the evaluation run.
 *
 * Best-effort collectors (agent metadata, costs, Redis, container logs)
 * catch and record failures without aborting.
 */
export async function assembleEvidence(ctx: EvidenceAssemblyContext): Promise<EvidenceManifest> {
  const entries: EvidenceManifestEntry[] = [];
  const timeFilter = scopeTimeFilter(ctx.scope, ctx.sessionTimestamps);

  // Pre-fetch bot IDs once — shared across fills, journal, and positions loaders
  // to avoid querying the bots table 4 times per evaluation run.
  const botIds = await loadAgentBotIds(ctx.db, ctx.agentId);
  const loaderOpts = { ...timeFilter, botIds };

  // ── Fills (core — must succeed) ────────────────────────────────────────
  const fills = await loadAgentFills(ctx.db, ctx.agentId, loaderOpts);
  // Write raw data — redaction happens after analysis in the orchestrator
  await ctx.store.write(ctx.runId, 'fills.json', JSON.stringify(fills, null, 2));
  entries.push({ artifactName: 'fills.json', collected: true, itemCount: fills.length });

  // ── Journal events (core — must succeed) ───────────────────────────────
  const journal = await loadAgentJournalEvents(ctx.db, ctx.agentId, loaderOpts);
  await ctx.store.write(ctx.runId, 'journal.json', JSON.stringify(journal, null, 2));
  entries.push({ artifactName: 'journal.json', collected: true, itemCount: journal.length });

  // ── Runtime sessions (core — must succeed) ─────────────────────────────
  const sessions = await loadAgentRuntimeSessions(ctx.db, ctx.agentId, timeFilter);
  await ctx.store.write(ctx.runId, 'sessions.json', JSON.stringify(sessions, null, 2));
  entries.push({ artifactName: 'sessions.json', collected: true, itemCount: sessions.length });

  // ── Positions snapshot (core — must succeed) ───────────────────────────
  const at = timeFilter?.at;
  const positions = await loadAgentPositions(ctx.db, ctx.agentId, { ...(at ? { at } : {}), botIds });
  await ctx.store.write(ctx.runId, 'positions.json', JSON.stringify(positions, null, 2));
  entries.push({ artifactName: 'positions.json', collected: true, itemCount: positions.length });

  // ── Agent metadata (best-effort) ───────────────────────────────────────
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

  // ── Cost data (best-effort — queries billingUsageEvents by agentId) ────
  try {
    const billingEvents = await ctx.db
      .select({
        meterKey: billingUsageEvents.meterKey,
        totalQuantity: sql<number>`sum(${billingUsageEvents.quantity})`,
        unit: billingUsageEvents.unit,
      })
      .from(billingUsageEvents)
      .where(and(
        eq(billingUsageEvents.agentId, ctx.agentId),
        ...(timeFilter?.from ? [gte(billingUsageEvents.occurredAt, timeFilter.from)] : []),
        ...(timeFilter?.to ? [lte(billingUsageEvents.occurredAt, timeFilter.to)] : []),
      ))
      .groupBy(billingUsageEvents.meterKey, billingUsageEvents.unit);

    const costSummary = billingEvents.map((e) => ({
      meterKey: e.meterKey,
      totalQuantity: e.totalQuantity,
      unit: e.unit,
    }));

    await ctx.store.write(ctx.runId, 'costs.json', JSON.stringify(costSummary, null, 2));
    entries.push({ artifactName: 'costs.json', collected: true, itemCount: costSummary.length });
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

  // ── Container logs (best-effort) ───────────────────────────────────────
  const logsEntry = await collectContainerLogs(ctx.agentId, ctx.store, ctx.runId);
  entries.push(logsEntry);

  return { entries, scope: ctx.scope };
}
