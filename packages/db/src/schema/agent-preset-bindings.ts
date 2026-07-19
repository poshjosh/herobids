import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { marketAssessmentArtifacts } from './market-assessment-artifacts.js';
import { agentPresetTransitions } from './agent-preset-transitions.js';

/**
 * Agent preset bindings — authoritative first-class preset-binding state
 * per agent and scope. Each row records the active preset key, style tier,
 * behavior version, applied preset/config version, and the source artifact
 * or transition that established the binding.
 *
 * Unique constraint per (agentId, scope) ensures at most one active binding
 * per agent × scope.
 */
export const agentPresetBindings = pgTable('agent_preset_bindings', {
  id: text('id').primaryKey(),
  /** Agent this binding belongs to */
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** Scope: 'default' or a serialized canonical identity (e.g. orderbook|hyperliquid|standard|BTC) */
  scope: text('scope').notNull(),
  /** The key of the active preset (e.g. momentum_v1) */
  activePresetKey: text('active_preset_key').notNull(),
  /** Style tier: economy | standard | premium */
  styleTier: text('style_tier').notNull(),
  /** Mechanically derived behavior version */
  behaviorVersion: text('behavior_version').notNull().default('v1'),
  /** The preset/config version applied */
  appliedPresetVersion: text('applied_preset_version').notNull().default('v1'),
  /** Assessment artifact that informed this binding (null if agent-initiated) */
  sourceArtifactId: text('source_artifact_id').references(() => marketAssessmentArtifacts.id, { onDelete: 'set null' }),
  /** Transition that established this binding (null if set directly) */
  sourceTransitionId: text('source_transition_id').references(() => agentPresetTransitions.id, { onDelete: 'set null' }),
  /** Binding status: active | superseded | revoked */
  status: text('status').notNull().default('active'),
  /** When the binding was applied */
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_preset_bindings_agent_id').on(t.agentId),
  index('idx_agent_preset_bindings_status').on(t.status),
  uniqueIndex('uq_agent_preset_bindings_agent_scope').on(t.agentId, t.scope),
]);
