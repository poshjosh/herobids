import { pgTable, text, timestamp, jsonb, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { marketAssessmentArtifacts } from './market-assessment-artifacts.js';

/**
 * Market assessment wake decisions — per-agent, per-artifact wake-gate outcomes.
 * Records whether the platform decided to emit or suppress a review wake
 * for a specific agent based on the materiality of a preset-fit improvement.
 */
export const marketAssessmentWakeDecisions = pgTable('market_assessment_wake_decisions', {
  id: text('id').primaryKey(),
  /** The assessment artifact this decision references */
  assessmentArtifactId: text('assessment_artifact_id').notNull().references(() => marketAssessmentArtifacts.id, { onDelete: 'restrict' }),
  /** Agent the wake decision is for */
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
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
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  decision: text('decision').notNull(), // wake_emitted | wake_suppressed
  /** Reason for suppression (null when wake was emitted) */
  suppressionReason: text('suppression_reason'),
  /** Score uplift of recommended preset over agent's current preset */
  scoreUplift: numeric('score_uplift'),
  /** Assessor confidence at decision time (0-1) */
  confidence: numeric('confidence').notNull(),
  /** The preset the agent was using at decision time */
  agentCurrentPreset: text('agent_current_preset').notNull(),
  /** The recommended preset from the artifact */
  recommendedPreset: text('recommended_preset').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_market_assessment_wake_decisions_agent_id').on(t.agentId),
  index('idx_market_assessment_wake_decisions_artifact_id').on(t.assessmentArtifactId),
  index('idx_market_assessment_wake_decisions_decision').on(t.decision),
  index('idx_market_assessment_wake_decisions_decided_at').on(t.decidedAt),
  index('idx_market_assessment_wake_decisions_segment_components').on(t.venueFamily, t.styleTier, t.universeScopeHash),
  uniqueIndex('uq_market_assessment_wake_decisions_agent_artifact').on(t.agentId, t.assessmentArtifactId),
]);
