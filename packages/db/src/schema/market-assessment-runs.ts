import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

/**
 * Market assessment runs — platform-owned assessment executions for a market segment.
 * Each row tracks a single assessment run: config, status, and collected evidence.
 */
export const marketAssessmentRuns = pgTable('market_assessment_runs', {
  id: text('id').primaryKey(),
  /** Segment key as JSON: { venueFamily, styleTier, universeScopeHash } */
  segmentKey: jsonb('segment_key').notNull().$type<{
    venueFamily: string;
    styleTier: string;
    universeScopeHash: string;
  }>(),
  /** Denormalized segment key components for efficient querying */
  venueFamily: text('venue_family').notNull(),
  styleTier: text('style_tier').notNull(),
  universeScopeHash: text('universe_scope_hash').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'), // pending | in_progress | completed | failed | budget_exhausted
  evidenceRefs: jsonb('evidence_refs').notNull().$type<string[]>(),
  errorMessage: text('error_message'),
  assessmentVersion: integer('assessment_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_market_assessment_runs_status').on(t.status),
  index('idx_market_assessment_runs_segment_key').on(t.segmentKey),
  index('idx_market_assessment_runs_started_at').on(t.startedAt),
  index('idx_market_assessment_runs_segment_components').on(t.venueFamily, t.styleTier, t.universeScopeHash),
]);
