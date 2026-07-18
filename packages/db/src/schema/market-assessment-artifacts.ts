import { pgTable, text, timestamp, jsonb, integer, numeric, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { marketAssessmentRuns } from './market-assessment-runs.js';

/**
 * Market assessment artifacts — cached shared assessment results per
 * canonical per-symbol identity.
 * Each row represents a completed assessment artifact that agents can consume
 * to make preset-transition decisions.
 */
export const marketAssessmentArtifacts = pgTable('market_assessment_artifacts', {
  id: text('id').primaryKey(),

  // ── Canonical identity columns ──────────────────────────────────────────

  /** Instrument kind: orderbook | perp | swap | dex */
  instrumentKind: text('instrument_kind').notNull(),
  /** Venue family (e.g. hyperliquid, jupiter) */
  venueFamily: text('venue_family').notNull(),
  /** Style tier: economy | standard | premium */
  styleTier: text('style_tier').notNull(),
  /** Symbol — required for orderbook/perp, null for swap/dex */
  symbol: text('symbol'),
  /** Network (canonical chain id) — required for swap/dex, null for orderbook/perp */
  network: text('network'),
  /** Address (canonical token address) — required for swap/dex, null for orderbook/perp */
  address: text('address'),

  // ── Identity snapshot for audit replay ──────────────────────────────────

  /** Immutable canonical identity snapshot as JSON. */
  identitySnapshot: jsonb('identity_snapshot').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),

  // ── Artifact content ────────────────────────────────────────────────────

  /** The assessment run that produced this artifact */
  assessmentRunId: text('assessment_run_id').notNull().references(() => marketAssessmentRuns.id, { onDelete: 'restrict' }),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** ISO 8601 duration or timestamp — max age for actor use */
  maxActorUseAge: text('max_actor_use_age').notNull(),
  /** ISO 8601 duration or timestamp — max age for wake emission */
  maxWakeAge: text('max_wake_age').notNull(),
  assessmentVersion: integer('assessment_version').notNull().default(1),
  artifactVersion: integer('artifact_version').notNull().default(1),
  rankingPolicyVersion: integer('ranking_policy_version').notNull().default(1),
  /** Lifecycle status: active | expired | superseded */
  status: text('status').notNull().default('active'),
  /** Allowed preset keys for this identity */
  allowedPresets: jsonb('allowed_presets').notNull().$type<string[]>(),
  /** LLM-produced narrative summary of current market conditions */
  currentMarketSummary: text('current_market_summary').notNull().default(''),
  /** LLM-produced narrative summary of market regime */
  regimeSummary: text('regime_summary').notNull().default(''),
  /** Summary of scanner health across presets */
  scanHealthSummary: text('scan_health_summary').notNull().default(''),
  /** Ranked preset assessments */
  presetRankings: jsonb('preset_rankings').notNull().$type<
    Array<{
      presetKey: string;
      presetBehaviorVersion: string;
      rank: number;
      score: number;
      scoreBand: string;
      pros: string[];
      cons: string[];
      fitNotes: string | null;
    }>
  >(),
  /** Top-ranked preset key (null if no clear recommendation) */
  recommendedPreset: text('recommended_preset'),
  /** Estimated score uplift of recommended preset over others */
  relativeUplift: numeric('relative_uplift'),
  /** Assessor confidence in the ranking (0-1) */
  confidence: numeric('confidence').notNull(),
  /** How urgently the platform assessor recommends review */
  urgency: text('urgency').notNull().default('low'), // low | medium | high
  /** LLM-produced reasoning behind the assessment */
  reasoningSummary: text('reasoning_summary').notNull().default(''),
  /** References to raw evidence used */
  evidenceRefs: jsonb('evidence_refs').notNull().$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_market_assessment_artifacts_assessment_run_id').on(t.assessmentRunId),
  index('idx_market_assessment_artifacts_expires_at').on(t.expiresAt),
  index('idx_market_assessment_artifacts_assessed_at').on(t.assessedAt),
  index('idx_market_assessment_artifacts_identity_lookup').on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  // At most one active artifact per orderbook/perp identity
  uniqueIndex('uq_market_assessment_artifacts_orderbook_active')
    .on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol)
    .where(sql`${t.status} = 'active' AND ${t.instrumentKind} IN ('orderbook', 'perp')`),
  // At most one active artifact per swap/dex identity
  uniqueIndex('uq_market_assessment_artifacts_swap_active')
    .on(t.instrumentKind, t.venueFamily, t.styleTier, t.network, t.address)
    .where(sql`${t.status} = 'active' AND ${t.instrumentKind} IN ('swap', 'dex')`),
  // orderbook/perp → symbol NOT NULL, network IS NULL, address IS NULL
  check('chk_market_assessment_artifacts_orderbook_perp', sql`
    (${t.instrumentKind} IN ('orderbook', 'perp') AND ${t.symbol} IS NOT NULL AND ${t.network} IS NULL AND ${t.address} IS NULL)
    OR ${t.instrumentKind} NOT IN ('orderbook', 'perp')
  `),
  // swap/dex → network NOT NULL, address NOT NULL, symbol IS NULL
  check('chk_market_assessment_artifacts_swap_dex', sql`
    (${t.instrumentKind} IN ('swap', 'dex') AND ${t.network} IS NOT NULL AND ${t.address} IS NOT NULL AND ${t.symbol} IS NULL)
    OR ${t.instrumentKind} NOT IN ('swap', 'dex')
  `),
]);
