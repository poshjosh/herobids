import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Agent assessment review checks — durable per-agent review-cycle state.
 *
 * Each row records one review check for an agent. The pre-check reads
 * persisted scanner candidates, evaluates them against the deterministic
 * review predicate, and persists outcomes. This table stores the check
 * metadata and serves as the authoritative source for `isReviewDue()`.
 *
 * Review advice rows (`review_advice`) reference this check record via
 * `check_id`, so multiple advice outcomes from one check are linked.
 */
export const agentAssessmentReviewChecks = pgTable('agent_assessment_review_checks', {
  // ── Primary key ──
  id: text('id').primaryKey(),

  // ── Agent context ──
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),

  // ── Effective interval at check time ──
  /** The review interval in ms that was effective for this check. */
  effectiveIntervalMs: integer('effective_interval_ms').notNull(),

  // ── Timing ──
  /** When this review check became due. */
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  /** When the check was actually performed. */
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** When the next review is eligible. */
  nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }),

  // ── Status ──
  /**
   * Status of this review check:
   * - pending: due but not yet executed
   * - in_progress: lease acquired, pre-check running
   * - completed: pre-check finished (may or may not have advice)
   * - failed: pre-check encountered an error
   * - skipped: agent was disabled/misconfigured at check time
   * - lease_lost: lease expired before check could complete
   */
  status: text('status').notNull().default('pending'),

  // ── Lease / recovery ──
  /** Worker ID that holds the lease for this check. */
  leaseHolderId: text('lease_holder_id'),
  /** When the lease was acquired. */
  leaseAcquiredAt: timestamp('lease_acquired_at', { withTimezone: true }),
  /** When the lease expires. */
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  /** Recovered at — set by the reconciler when a lost lease is recovered. */
  recoveredAt: timestamp('recovered_at', { withTimezone: true }),

  // ── Policy ──
  /** Version of the review predicate policy used for this check. */
  policyVersion: text('policy_version'),

  // ── Outcome summary ──
  /** Summary JSON: { advisedCount, blockedCount, staleCount, ... }. */
  outcomeSummary: jsonb('outcome_summary').$type<Record<string, unknown>>(),
  /** Top-level outcome: advised | no_candidate | no_advice | misconfigured | failed. */
  checkOutcome: text('check_outcome'),

  // ── Error details ──
  /** Error code and message if the check failed. */
  errorDetails: jsonb('error_details').$type<Record<string, unknown>>(),

  // ── Lifecycle ──
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_review_checks_agent_id').on(t.agentId),
  index('idx_review_checks_status').on(t.status),
  index('idx_review_checks_due_at').on(t.dueAt),
  index('idx_review_checks_agent_status').on(t.agentId, t.status),
  index('idx_review_checks_lease_expires').on(t.leaseExpiresAt),
]);
