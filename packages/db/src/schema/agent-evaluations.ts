import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Agent evaluation runs — persisted metadata for each evaluation job.
 *
 * Scope-aware dedupe: only one active run (queued/running) per agent per resolved scope.
 * Enforced by a partial unique index on (agent_id, scope_key) WHERE status IN ('queued', 'running')
 * (see migration 0025), with an application-level transaction guard as a secondary check.
 *
 * Both `requested_scope_json` and `resolved_scope_json` are stored:
 * - `requested_scope_json`: what the caller asked for (may include `latestSession`)
 * - `resolved_scope_json`: concrete scope used by the worker (always session/timeRange/allTime)
 */
export const agentEvaluations = pgTable('agent_evaluations', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'), // queued | running | succeeded | failed | timed_out
  trigger: text('trigger').notNull(),                 // manual | session_stop | scheduled | trade_test
  /** Original caller intent (may be `latestSession`) */
  requestedScopeJson: jsonb('requested_scope_json').notNull().$type<Record<string, unknown>>(),
  /** Concrete scope used by worker (always session/timeRange/allTime) */
  resolvedScopeJson: jsonb('resolved_scope_json').notNull().$type<Record<string, unknown>>(),
  /** Normalized scope key for dedupe (derived from resolved scope) */
  scopeKey: text('scope_key').notNull(),
  /** Actor-based provenance: user | system | agent */
  requestedByType: text('requested_by_type').notNull(),
  /** UUID of the requester (null for system-triggered) */
  requestedById: text('requested_by_id'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  timedOutAt: timestamp('timed_out_at', { withTimezone: true }),
  attempt: integer('attempt').notNull().default(1),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  /** Full scorecard JSON (EvaluationScorecard) */
  scorecardJson: jsonb('scorecard_json').$type<Record<string, unknown>>(),
  /** Summary JSON { totalFindings, criticalCount, highCount } */
  summaryJson: jsonb('summary_json').$type<Record<string, unknown>>(),
  /** Artifact manifest JSON (EvaluationArtifactRef[]) */
  artifactManifestJson: jsonb('artifact_manifest_json').$type<Record<string, unknown>[]>(),
}, (t) => [
  index('idx_agent_evaluations_agent_id').on(t.agentId),
  index('idx_agent_evaluations_status').on(t.status),
  index('idx_agent_evaluations_scope_key').on(t.agentId, t.scopeKey),
  index('idx_agent_evaluations_requested_at').on(t.requestedAt),
]);
