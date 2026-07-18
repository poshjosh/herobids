import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { marketAssessmentArtifacts } from './market-assessment-artifacts.js';

/**
 * Agent preset transitions — recorded preset-switch events for an agent.
 * Each row captures a complete transition: old preset, new preset, mode,
 * open-position context, and outcome.
 */
export const agentPresetTransitions = pgTable('agent_preset_transitions', {
  id: text('id').primaryKey(),
  /** Agent that performed the transition */
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** Previous preset key */
  oldPresetKey: text('old_preset_key').notNull(),
  /** Previous preset behavior version */
  oldPresetBehaviorVersion: text('old_preset_behavior_version').notNull(),
  /** New preset key */
  newPresetKey: text('new_preset_key').notNull(),
  /** New preset behavior version */
  newPresetBehaviorVersion: text('new_preset_behavior_version').notNull(),
  /** Assessment artifact that informed this transition (null if agent-initiated) */
  assessmentArtifactId: text('assessment_artifact_id').references(() => marketAssessmentArtifacts.id, { onDelete: 'set null' }),
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
  /** Execution mode: shadow | live */
  mode: text('mode').notNull().default('live'),
  /** How existing positions were handled */
  transitionMode: text('transition_mode').notNull(), // entries_only | entries_and_tighten_existing | entries_and_full_transition
  /** Number of open positions at transition time */
  openPositionCount: integer('open_position_count').notNull().default(0),
  /** Transition outcome */
  outcome: text('outcome').notNull(), // accepted | deferred | rejected
  /** Reason for deferral or rejection (null if accepted) */
  reason: text('reason'),
  /** When the transition was applied */
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
  /** Snapshot of regime context at transition time */
  regimeSnapshot: jsonb('regime_snapshot').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_preset_transitions_agent_id').on(t.agentId),
  index('idx_agent_preset_transitions_applied_at').on(t.appliedAt),
  index('idx_agent_preset_transitions_outcome').on(t.outcome),
  index('idx_agent_preset_transitions_segment_key').on(t.segmentKey),
  index('idx_agent_preset_transitions_segment_components').on(t.venueFamily, t.styleTier, t.universeScopeHash),
]);
