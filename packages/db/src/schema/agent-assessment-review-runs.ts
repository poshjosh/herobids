import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { users } from './users.js';
import { agentAssessmentReviewChecks } from './agent-assessment-review-checks.js';

/**
 * Agent assessment review runs — durable per-agent manual-review request lifecycle.
 *
 * Each row records a user-triggered manual review request for an agent. The
 * API creates a row and enqueues a job; the worker picks up the job, executes
 * the shared review runner with force:true, and persists the terminal result.
 *
 * This table is distinct from `agent_assessment_review_checks` (the actual
 * pre-check facts) and `review_advice` (per-candidate outcomes). It serves as
 * the pollable status model for the frontend and the durable audit trail for
 * manual operator actions.
 */
export const agentAssessmentReviewRuns = pgTable('agent_assessment_review_runs', {
  // ── Primary key ──
  id: text('id').primaryKey(),

  // ── Agent & user context ──
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  requestedByUserId: text('requested_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // ── Lifecycle status ──
  /** queued | running | succeeded | failed */
  status: text('status').notNull().default('queued'),

  // ── Trigger source ──
  /** Always 'manual_frontend' in v1. Reserved for future expansion. */
  trigger: text('trigger').notNull().default('manual_frontend'),

  // ── Timing ──
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  // ── Linked review check ──
  /** FK to the actual review check row produced by the shared runner. Null until check completes. */
  checkId: text('check_id').references(() => agentAssessmentReviewChecks.id, { onDelete: 'set null' }),

  // ── Result summary ──
  /**
   * JSON payload with terminal result data for frontend consumption:
   * { hasAdvice, advisedCount, outcomeCounts, checkOutcome, checkedAt, nextEligibleAt, checkId }
   */
  resultSummary: jsonb('result_summary').$type<Record<string, unknown>>(),

  // ── Error details ──
  errorCode: text('error_code'),
  errorMessage: text('error_message'),

  // ── Lifecycle ──
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_review_runs_agent_id').on(t.agentId),
  index('idx_review_runs_status').on(t.status),
  index('idx_review_runs_agent_status').on(t.agentId, t.status),
]);
