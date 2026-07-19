import type { Database } from '@herobids/db';
import {
  reviewAdvice,
  marketAssessmentRequests,
  agentPresetTransitions,
  agentPresetBindings,
} from '@herobids/db';
import { and, eq, gte, lte, desc } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PresetAssessmentEvidence {
  /** Raw rows from review_advice for the agent × time window. */
  reviewAdviceRows: Array<Record<string, unknown>>;
  /** Raw rows from market_assessment_requests for the agent × time window. */
  requestRows: Array<Record<string, unknown>>;
  /** Raw rows from agent_preset_transitions for the agent × time window. */
  transitionRows: Array<Record<string, unknown>>;
  /** Current active default binding (null if none or lookup failed). */
  defaultBindingRow: Record<string, unknown> | null;
  /** Caveats from best-effort query failures. */
  auditCaveats: string[];
  /** ISO timestamp when evidence was collected. */
  collectedAt: string;
}

export interface CollectPresetAssessmentContext {
  db: Database;
  agentId: string;
  timeFilter?: { from?: Date; to?: Date };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a compact identity string from a row's identity columns.
 *
 * Prefers denormalized identity columns when present (review_advice,
 * market_assessment_requests). Falls back to identitySnapshot for rows
 * that lack venueFamily/styleTier columns (agent_preset_transitions,
 * agent_preset_bindings).
 *
 * Orderbook/perp: "{instrumentKind}:{venueFamily}:{symbol}:{styleTier}"
 * Swap/dex:       "{instrumentKind}:{venueFamily}:{styleTier}:{network}:{address}"
 * Fallback:       "{instrumentKind}:{venueFamily}:{styleTier}"
 */
export function buildCompactIdentity(row: Record<string, unknown>): string {
  // Prefer denormalized columns; fall back to identitySnapshot when absent
  // (e.g. agent_preset_transitions rows lack venueFamily/styleTier).
  const snapshot = row.identitySnapshot as Record<string, unknown> | undefined;
  const instrumentKind = String(
    row.instrumentKind ?? snapshot?.instrumentKind ?? '?',
  );
  const venueFamily = String(
    row.venueFamily ?? snapshot?.venueFamily ?? '?',
  );
  const styleTier = String(
    row.styleTier ?? snapshot?.styleTier ?? '?',
  );
  const symbol = String(
    row.symbol ?? snapshot?.symbol ?? '?',
  );
  const network = String(
    row.network ?? snapshot?.network ?? '?',
  );
  const address = String(
    row.address ?? snapshot?.address ?? '?',
  );

  if (instrumentKind === 'orderbook' || instrumentKind === 'perp') {
    return `${instrumentKind}:${venueFamily}:${symbol}:${styleTier}`;
  }

  if (instrumentKind === 'swap' || instrumentKind === 'dex') {
    return `${instrumentKind}:${venueFamily}:${styleTier}:${network}:${address}`;
  }

  return `${instrumentKind}:${venueFamily}:${styleTier}`;
}

// ── Collector ───────────────────────────────────────────────────────────────

/**
 * Collect preset-assessment evidence for an agent within a time window.
 *
 * Every query is best-effort — failures add audit caveats rather than
 * throwing, so the evaluation pipeline can still produce a partial report.
 */
export async function collectPresetAssessmentEvidence(
  ctx: CollectPresetAssessmentContext,
): Promise<PresetAssessmentEvidence> {
  const caveats: string[] = [];
  const collectedAt = new Date().toISOString();

  // ── review_advice ──────────────────────────────────────────────────────
  let reviewAdviceRows: Array<Record<string, unknown>> = [];
  try {
    reviewAdviceRows = (await ctx.db
      .select()
      .from(reviewAdvice)
      .where(
        and(
          eq(reviewAdvice.agentId, ctx.agentId),
          ...(ctx.timeFilter?.from ? [gte(reviewAdvice.checkedAt, ctx.timeFilter.from)] : []),
          ...(ctx.timeFilter?.to ? [lte(reviewAdvice.checkedAt, ctx.timeFilter.to)] : []),
        ),
      )
      .orderBy(desc(reviewAdvice.checkedAt))) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    caveats.push(`review_advice collection failed: ${String(err)}`);
  }

  // ── market_assessment_requests ─────────────────────────────────────────
  let requestRows: Array<Record<string, unknown>> = [];
  try {
    requestRows = (await ctx.db
      .select()
      .from(marketAssessmentRequests)
      .where(
        and(
          eq(marketAssessmentRequests.agentId, ctx.agentId),
          ...(ctx.timeFilter?.from
            ? [gte(marketAssessmentRequests.requestedAt, ctx.timeFilter.from)]
            : []),
          ...(ctx.timeFilter?.to
            ? [lte(marketAssessmentRequests.requestedAt, ctx.timeFilter.to)]
            : []),
        ),
      )
      .orderBy(desc(marketAssessmentRequests.requestedAt))) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    caveats.push(`market_assessment_requests collection failed: ${String(err)}`);
  }

  // ── agent_preset_transitions ───────────────────────────────────────────
  let transitionRows: Array<Record<string, unknown>> = [];
  try {
    transitionRows = (await ctx.db
      .select()
      .from(agentPresetTransitions)
      .where(
        and(
          eq(agentPresetTransitions.agentId, ctx.agentId),
          ...(ctx.timeFilter?.from
            ? [gte(agentPresetTransitions.appliedAt, ctx.timeFilter.from)]
            : []),
          ...(ctx.timeFilter?.to
            ? [lte(agentPresetTransitions.appliedAt, ctx.timeFilter.to)]
            : []),
        ),
      )
      .orderBy(desc(agentPresetTransitions.appliedAt))) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    caveats.push(`agent_preset_transitions collection failed: ${String(err)}`);
  }

  // ── agent_preset_bindings (current default) ────────────────────────────
  let defaultBindingRow: Record<string, unknown> | null = null;
  try {
    const bindings = (await ctx.db
      .select()
      .from(agentPresetBindings)
      .where(
        and(
          eq(agentPresetBindings.agentId, ctx.agentId),
          eq(agentPresetBindings.scope, 'default'),
          eq(agentPresetBindings.status, 'active'),
        ),
      )
      .limit(1)) as unknown as Array<Record<string, unknown>>;
    if (bindings.length > 0) {
      defaultBindingRow = bindings[0]!;
    }
  } catch (err) {
    caveats.push(`agent_preset_bindings collection failed: ${String(err)}`);
  }

  return {
    reviewAdviceRows,
    requestRows,
    transitionRows,
    defaultBindingRow,
    auditCaveats: caveats,
    collectedAt,
  };
}
