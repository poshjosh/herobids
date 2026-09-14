import type { Database } from '@herobids/db';
import {
  loadAgentRuntimeSessions,
  AgentRepository,
  billingUsageEvents,
} from '@herobids/db';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { ResolvedEvaluationScope, EvaluationArtifactStore } from '@herobids/domain';
import { collectContainerLogs } from './container-logs.js';
import {
  collectPresetAssessmentEvidence,
  type PresetAssessmentEvidence,
} from './preset-assessment-evidence.js';
import type { FillRow, JournalRow, PositionRow } from './evidence-row-mappers.js';

// ── Ports ───────────────────────────────────────────────────────────────────

/**
 * Agent-scoped trading evidence, sourced over the Traderton read boundary.
 *
 * Fills, journal events, and positions are Traderton-owned data: the boundary
 * tools (`get_agent_fills` / `get_agent_journal_events` / `get_agent_positions`)
 * resolve the agent's owned bots server-side, so the assembler no longer
 * pre-resolves bot IDs. Each method returns the herobids row shapes the
 * analyzers expect, with date columns rehydrated from the boundary's ISO
 * strings (see evidence-row-mappers).
 *
 * This is core evaluation evidence — the port MUST succeed. Its methods throw
 * on a boundary failure so the run aborts (no local fallback), mirroring the
 * mandatory-boundary posture of the side-effecting path.
 */
export interface AgentEvidencePort {
  getFills(opts: { from?: Date; to?: Date }): Promise<FillRow[]>;
  getJournalEvents(opts: { from?: Date; to?: Date }): Promise<JournalRow[]>;
  getPositions(opts: { from?: Date; to?: Date; at?: Date }): Promise<PositionRow[]>;
}

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
  /** Best-effort preset-assessment evidence collected during assembly. */
  presetAssessmentEvidence?: PresetAssessmentEvidence;
}

export interface EvidenceAssemblyContext {
  db: Database;
  agentId: string;
  scope: ResolvedEvaluationScope;
  store: EvaluationArtifactStore;
  runId: string;
  /**
   * Port for agent trading evidence (fills / journal / positions) over the
   * Traderton read boundary. REQUIRED — core evidence must succeed. The
   * orchestrator builds it per-run from a read boundary + the agent's subject.
   */
  agentEvidencePort: AgentEvidencePort;
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
  const from = timeFilter?.from;
  const to = timeFilter?.to;
  const at = timeFilter?.at;

  // Fills / journal / positions are Traderton-owned — sourced over the read
  // boundary. The boundary tools resolve agent-owned bots server-side, so no
  // local bot-ID pre-resolution is needed.

  // ── Fills (core — must succeed) ────────────────────────────────────────
  const fills = await ctx.agentEvidencePort.getFills({ from, to });
  // Write raw data — redaction happens after analysis in the orchestrator
  await ctx.store.write(ctx.runId, 'fills.json', JSON.stringify(fills, null, 2));
  entries.push({ artifactName: 'fills.json', collected: true, itemCount: fills.length });

  // ── Journal events (core — must succeed) ───────────────────────────────
  const journal = await ctx.agentEvidencePort.getJournalEvents({ from, to });
  await ctx.store.write(ctx.runId, 'journal.json', JSON.stringify(journal, null, 2));
  entries.push({ artifactName: 'journal.json', collected: true, itemCount: journal.length });

  // ── Runtime sessions (core — must succeed, PLATFORM-local) ─────────────
  // agent_runtime_sessions is a platform table (not Traderton) — stays local.
  const sessions = await loadAgentRuntimeSessions(ctx.db, ctx.agentId, timeFilter);
  await ctx.store.write(ctx.runId, 'sessions.json', JSON.stringify(sessions, null, 2));
  entries.push({ artifactName: 'sessions.json', collected: true, itemCount: sessions.length });

  // ── Positions snapshot (core — must succeed) ───────────────────────────
  const positions = await ctx.agentEvidencePort.getPositions({ ...(at ? { at } : {}) });
  await ctx.store.write(ctx.runId, 'positions.json', JSON.stringify(positions, null, 2));
  entries.push({ artifactName: 'positions.json', collected: true, itemCount: positions.length });

  // ── Agent metadata (best-effort) ───────────────────────────────────────
  try {
    const agentRepo = new AgentRepository(ctx.db);
    const agent = await agentRepo.getAgent(ctx.agentId);
    if (agent) {
      const risk = (agent.risk ?? {}) as Record<string, unknown>;
      const execDefaults = (agent.executionDefaults ?? {}) as Record<string, unknown>;
      const metadata = {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        style: agent.style,
        // Canonical JSONB fields (legacy flat columns removed)
        executionMode: execDefaults['mode'] ?? null,
        dailyLossLimit: null,
        maxBots: agent.maxBots,
        maxSlippageBps: execDefaults['slippageBps'] ?? null,
        // Canonical JSONB fields
        dailyMaxLossPct: risk['dailyMaxLossPct'] ?? null,
        maxDrawdownPct: risk['maxDrawdownPct'] ?? null,
        slippageBps: execDefaults['slippageBps'] ?? null,
        executionModeCanonical: execDefaults['mode'] ?? null,
        createdAt: agent.createdAt,
      };
      await ctx.store.write(ctx.runId, 'agent-metadata.json', JSON.stringify(metadata, null, 2));
      entries.push({ artifactName: 'agent-metadata.json', collected: true });

      // Unified agent config — always emit when agent row exists, even if null
      await ctx.store.write(
        ctx.runId,
        'unified-agent-config.json',
        JSON.stringify(agent.unifiedConfig ?? null, null, 2),
      );
      entries.push({ artifactName: 'unified-agent-config.json', collected: true });
    } else {
      entries.push({ artifactName: 'agent-metadata.json', collected: false, error: 'Agent not found' });
      entries.push({ artifactName: 'unified-agent-config.json', collected: false, error: 'Agent not found' });
    }
  } catch (err) {
    entries.push({ artifactName: 'agent-metadata.json', collected: false, error: String(err) });
    entries.push({ artifactName: 'unified-agent-config.json', collected: false, error: String(err) });
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

  // ── Preset-assessment evidence (best-effort) ───────────────────────────
  let presetAssessmentEvidence: PresetAssessmentEvidence | undefined;
  try {
    presetAssessmentEvidence = await collectPresetAssessmentEvidence({
      db: ctx.db,
      agentId: ctx.agentId,
      timeFilter: timeFilter ? { from: timeFilter.from, to: timeFilter.to } : undefined,
    });
    entries.push({ artifactName: 'preset-assessment-evidence', collected: true });
  } catch (err) {
    entries.push({
      artifactName: 'preset-assessment-evidence',
      collected: false,
      error: String(err),
    });
  }

  return { entries, scope: ctx.scope, presetAssessmentEvidence };
}
