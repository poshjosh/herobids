import { pgTable, text, timestamp, jsonb, integer, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { marketAssessmentRuns } from './market-assessment-runs.js';

/**
 * Market assessment artifacts — cached shared assessment results per segment.
 * Each row represents a completed assessment artifact that agents can consume
 * to make preset-transition decisions.
 */
export const marketAssessmentArtifacts = pgTable('market_assessment_artifacts', {
  id: text('id').primaryKey(),
  /** Segment key as JSON: { venueFamily, styleTier, universeScopeHash } */
  segmentKey: jsonb('segment_key').notNull().$type<{
    venueFamily: string;
    styleTier: string;
    universeScopeHash: string;
  }>(),
  /** Denormalized segment key components for efficient querying */
  venueFamily: text('venue_family').notNull(),
  /** Style tier this artifact belongs to (denormalized from segmentKey) */
  styleTier: text('style_tier').notNull(),
  universeScopeHash: text('universe_scope_hash').notNull(),
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
  /** Allowed preset keys for this segment */
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
  index('idx_market_assessment_artifacts_segment_key').on(t.segmentKey),
  index('idx_market_assessment_artifacts_assessment_run_id').on(t.assessmentRunId),
  index('idx_market_assessment_artifacts_expires_at').on(t.expiresAt),
  index('idx_market_assessment_artifacts_assessed_at').on(t.assessedAt),
  index('idx_market_assessment_artifacts_segment_components').on(t.venueFamily, t.styleTier, t.universeScopeHash),
  uniqueIndex('uq_market_assessment_artifacts_segment_active')
    .on(t.segmentKey)
    .where(sql`${t.status} = 'active'`),
]);
