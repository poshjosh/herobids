import { pgTable, text, timestamp, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * decision_approvals — user-approval lifecycle for agent-direct trade proposals
 * when authorizationMode = 'approval_required'.
 *
 * approvalId (id) is the canonical object identifier.
 * shortCode is the human-facing, user-scoped lookup token.
 * Codes are never reused for the same user, even after resolution or expiry.
 */
export const decisionApprovals = pgTable('decision_approvals', {
  id: text('id').primaryKey(),
  shortCode: text('short_code').notNull(),
  userId: text('user_id').notNull(),
  agentId: text('agent_id').notNull(),
  actorType: text('actor_type').notNull().default('agent'),
  actorId: text('actor_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  authorizationModeSnapshot: text('authorization_mode_snapshot').notNull(),
  /** pending | approved | rejected | expired */
  status: text('status').notNull(),
  /** accepted | rejected | error | null — set after approval is resolved and execution is attempted */
  executionStatus: text('execution_status'),
  instrumentId: text('instrument_id').notNull(),
  intent: text('intent').notNull(),
  targetSize: numeric('target_size').notNull(),
  limitPrice: numeric('limit_price'),
  stopLoss: numeric('stop_loss'),
  takeProfit: numeric('take_profit'),
  confidence: numeric('confidence'),
  rationaleSummary: text('rationale_summary').notNull(),
  contextHash: text('context_hash'),
  proposedPayload: jsonb('proposed_payload').$type<Record<string, unknown>>().notNull(),
  decisionId: text('decision_id'),
  planId: text('plan_id'),
  resolvedByUserId: text('resolved_by_user_id'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  /** web | telegram_yes | telegram_no | api */
  resolutionSource: text('resolution_source'),
  lastResolutionAttemptAt: timestamp('last_resolution_attempt_at', { withTimezone: true }),
  lastResolutionErrorCode: text('last_resolution_error_code'),
  lastResolutionErrorMessage: text('last_resolution_error_message'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_decision_approvals_user_status_created_at').on(t.userId, t.status, t.createdAt),
  index('idx_decision_approvals_agent_status_created_at').on(t.agentId, t.status, t.createdAt),
  uniqueIndex('uq_decision_approvals_user_short_code').on(t.userId, t.shortCode),
]);
