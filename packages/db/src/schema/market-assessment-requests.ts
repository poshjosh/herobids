import { pgTable, text, timestamp, jsonb, bigint, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { users } from './users.js';
import { billingAccounts } from './billing-accounts.js';
import { billingPeriods } from './billing-periods.js';
import { marketAssessmentRuns } from './market-assessment-runs.js';
import { marketAssessmentArtifacts } from './market-assessment-artifacts.js';

export const marketAssessmentRequests = pgTable('market_assessment_requests', {
  // ── Primary key ──
  id: text('id').primaryKey(),

  // ── Requester ──
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),

  // ── Billing context ──
  billingAccountId: text('billing_account_id').notNull().references(() => billingAccounts.id),
  billingPeriodId: text('billing_period_id').references(() => billingPeriods.id),
  rateCardId: text('rate_card_id'),

  // ── Canonical identity columns (authoritative for lookups — R10) ──
  instrumentKind: text('instrument_kind').notNull(),
  venueFamily: text('venue_family').notNull(),
  styleTier: text('style_tier').notNull(),
  /** Symbol — required for orderbook/perp, null for swap/dex */
  symbol: text('symbol'),
  /** Network (canonical chain id) — required for swap/dex, null for orderbook/perp */
  network: text('network'),
  /** Address (canonical token address) — required for swap/dex, null for orderbook/perp */
  address: text('address'),

  // ── Identity snapshot (audit-only JSON, never read by query paths — R10) ──
  identitySnapshot: jsonb('identity_snapshot').notNull().default(sql`'{}'::jsonb`),

  // ── Idempotency & lineage ──
  /** Caller-supplied idempotency key (stable across retries) */
  idempotencyKey: text('idempotency_key'),
  /** 0-based attempt number within the request group */
  attemptNumber: integer('attempt_number').notNull().default(0),
  /** Deterministic key: hash of (agentId, instrumentKind, venueFamily, styleTier, symbol|network+address, idempotencyKey) */
  requestGroupKey: text('request_group_key').notNull(),

  // ── Lifecycle status ──
  /** in_progress | cache_hit | assessment_completed | provider_failed | billing_blocked | cooldown_blocked | identity_unresolved */
  status: text('status').notNull(),

  // ── Billing outcome ──
  billingOutcome: text('billing_outcome'), // reserved | captured | released | none
  /** Quoted (frozen) amount in microusd at reservation time */
  reservationAmountMicrousd: bigint('reservation_amount_microusd', { mode: 'number' }),
  /** Ledger entry ID for the reservation */
  reservationLedgerEntryId: text('reservation_ledger_entry_id'),
  /** Usage event ID for the settled capture (null if not captured) */
  captureUsageEventId: text('capture_usage_event_id'),
  /** Ledger entry ID for the capture (null if not captured) */
  captureLedgerEntryId: text('capture_ledger_entry_id'),
  /** Ledger entry ID for the release (null if not released) */
  releaseLedgerEntryId: text('release_ledger_entry_id'),

  // ── Linked resources ──
  assessmentRunId: text('assessment_run_id').references(() => marketAssessmentRuns.id),
  assessmentArtifactId: text('assessment_artifact_id').references(() => marketAssessmentArtifacts.id),

  // ── Cost observability (R12) — informational only, never used to compute user charge ──
  estimatedLlmCostMicrousd: bigint('estimated_llm_cost_microusd', { mode: 'number' }),
  llmInputTokens: bigint('llm_input_tokens', { mode: 'number' }),
  llmOutputTokens: bigint('llm_output_tokens', { mode: 'number' }),
  llmReasoningTokens: bigint('llm_reasoning_tokens', { mode: 'number' }),
  llmCallCount: integer('llm_call_count'),

  // ── Failure ──
  failureCode: text('failure_code'),
  failureMessage: text('failure_message'),

  // ── Timestamps ──
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Identity lookup for querying requests by canonical identity
  index('idx_market_assessment_requests_identity_lookup')
    .on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  // Daily cap counting: agentId + requestedAt for rolling 24h window (R7)
  index('idx_market_assessment_requests_agent_requested')
    .on(t.agentId, t.requestedAt),
  // Request group dedup: deterministic group key + attempt number (R9)
  uniqueIndex('uq_market_assessment_requests_group_attempt')
    .on(t.requestGroupKey, t.attemptNumber),
  // In-flight dedup: at most one in_progress per request group (R2)
  uniqueIndex('uq_market_assessment_requests_group_in_progress')
    .on(t.requestGroupKey)
    .where(sql`${t.status} = 'in_progress'`),
  // orderbook/perp → symbol NOT NULL, network IS NULL, address IS NULL
  check('chk_market_assessment_requests_orderbook_perp', sql`
    (${t.instrumentKind} IN ('orderbook', 'perp') AND ${t.symbol} IS NOT NULL AND ${t.network} IS NULL AND ${t.address} IS NULL)
    OR ${t.instrumentKind} NOT IN ('orderbook', 'perp')
  `),
  // swap/dex → network NOT NULL, address NOT NULL, symbol IS NULL
  check('chk_market_assessment_requests_swap_dex', sql`
    (${t.instrumentKind} IN ('swap', 'dex') AND ${t.network} IS NOT NULL AND ${t.address} IS NOT NULL AND ${t.symbol} IS NULL)
    OR ${t.instrumentKind} NOT IN ('swap', 'dex')
  `),
]);
