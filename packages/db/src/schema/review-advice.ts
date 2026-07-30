import { pgTable, text, timestamp, jsonb, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { agentAssessmentReviewChecks } from './agent-assessment-review-checks.js';

/**
 * Review-advice records — the handoff from deterministic scanner pre-check
 * to the agent's dedicated `assessment_review` tick.
 *
 * Each row captures one candidate's advice outcome from a single per-agent
 * review check. A single due check may produce multiple advice rows (one per
 * advised symbol). The advice is advisory only — no billing, no assessment
 * generation, no LLM invocation.
 */
export const reviewAdvice = pgTable('review_advice', {
  id: text('id').primaryKey(),
  /** Agent this advice is scoped to. */
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),

  // ── Review check linkage ─────────────────────────────────────────────────

  /** The review check that produced this advice row. */
  checkId: text('check_id').references(() => agentAssessmentReviewChecks.id, { onDelete: 'set null' }),

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
  identitySnapshot: jsonb('identity_snapshot').notNull().$type<Record<string, unknown>>(),

  // ── Timing ──────────────────────────────────────────────────────────────

  /** When the deterministic scanner pre-check ran. */
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  /** When review was due for this check cycle. */
  reviewDueAt: timestamp('review_due_at', { withTimezone: true }).notNull(),
  /** When the next review is eligible for this identity. */
  nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }).notNull(),

  // ── Candidate facts ────────────────────────────────────────────────────

  /** Position in the deterministic scanner ranking (1-based, null if no_candidate). */
  candidateRank: integer('candidate_rank'),
  /** Deterministic facts supporting the advice — cheap scanner data, no LLM. */
  supportingFacts: jsonb('supporting_facts').$type<Record<string, unknown>>(),

  // ── Agent preset context at check time ──────────────────────────────────

  /** The agent's active preset key at check time. */
  activePreset: text('active_preset').notNull(),
  /** Mechanically-derived behavior version at check time. */
  presetBehaviorVersion: text('preset_behavior_version').notNull(),

  // ── Advice outcome ─────────────────────────────────────────────────────

  /**
   * Outcome of the deterministic pre-check for this candidate:
   * - advised: candidate passed all checks, review is advised
   * - not_advised: candidate failed one or more checks
   * - blocked_by_cooldown: agent is within review cooldown for this identity
   * - blocked_by_no_credit_indication: non-reserving billing check indicates charge unlikely
   * - fresh_artifact_exists: a fresh assessment artifact already exists
   * - no_candidate: scanner returned no qualifying candidate
   */
  outcome: text('outcome').notNull().default('not_advised'),

  // ── Advice lifecycle ───────────────────────────────────────────────────

  /** When this advice record expires (no longer deliverable to the agent). */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** When the agent received this advice via the assessment_review tick (null if never consumed). */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  /** When the agent subsequently requested a platform assessment for this identity (null if advice not yet acted on). */
  assessmentRequestedAt: timestamp('assessment_requested_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_review_advice_agent_id').on(t.agentId),
  index('idx_review_advice_check_id').on(t.checkId),
  index('idx_review_advice_outcome').on(t.outcome),
  index('idx_review_advice_checked_at').on(t.checkedAt),
  index('idx_review_advice_consumed_at').on(t.consumedAt),
  index('idx_review_advice_assessment_requested_at').on(t.assessmentRequestedAt),
  index('idx_review_advice_identity_lookup').on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  index('idx_review_advice_agent_outcome_checked').on(t.agentId, t.outcome, t.checkedAt),
  // orderbook/perp → symbol NOT NULL, network IS NULL, address IS NULL
  check('chk_orderbook_perp_identity', sql`
    (instrument_kind IN ('orderbook', 'perp') AND symbol IS NOT NULL AND network IS NULL AND address IS NULL)
    OR instrument_kind NOT IN ('orderbook', 'perp')
  `),
  // swap/dex → network NOT NULL, address NOT NULL, symbol IS NULL
  check('chk_swap_dex_identity', sql`
    (instrument_kind IN ('swap', 'dex') AND network IS NOT NULL AND address IS NOT NULL AND symbol IS NULL)
    OR instrument_kind NOT IN ('swap', 'dex')
  `),
]);
