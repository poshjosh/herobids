import { pgTable, text, timestamp, jsonb, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Market assessment runs — platform-owned assessment executions for a
 * canonical per-symbol identity. Each row tracks a single assessment run:
 * config, status, and collected evidence.
 */
export const marketAssessmentRuns = pgTable('market_assessment_runs', {
  id: text('id').primaryKey(),

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
  identitySnapshot: jsonb('identity_snapshot').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),

  // ── Run lifecycle ───────────────────────────────────────────────────────

  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'), // pending | in_progress | completed | failed | budget_exhausted
  evidenceRefs: jsonb('evidence_refs').notNull().$type<string[]>(),
  /** Immutable evidence snapshot captured during assessment. */
  evidenceSnapshot: jsonb('evidence_snapshot').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  /** Deterministic scorecard results as JSON array. */
  scorecardSnapshots: jsonb('scorecard_snapshots').notNull().default(sql`'[]'::jsonb`).$type<Record<string, unknown>[]>(),
  /** Calculation versions for reproducibility/audit. */
  calculationVersions: jsonb('calculation_versions').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  errorMessage: text('error_message'),
  assessmentVersion: integer('assessment_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_market_assessment_runs_status').on(t.status),
  index('idx_market_assessment_runs_started_at').on(t.startedAt),
  index('idx_market_assessment_runs_identity_lookup').on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  // orderbook/perp → symbol NOT NULL, network IS NULL, address IS NULL
  check('chk_market_assessment_runs_orderbook_perp', sql`
    (${t.instrumentKind} IN ('orderbook', 'perp') AND ${t.symbol} IS NOT NULL AND ${t.network} IS NULL AND ${t.address} IS NULL)
    OR ${t.instrumentKind} NOT IN ('orderbook', 'perp')
  `),
  // swap/dex → network NOT NULL, address NOT NULL, symbol IS NULL
  check('chk_market_assessment_runs_swap_dex', sql`
    (${t.instrumentKind} IN ('swap', 'dex') AND ${t.network} IS NOT NULL AND ${t.address} IS NOT NULL AND ${t.symbol} IS NULL)
    OR ${t.instrumentKind} NOT IN ('swap', 'dex')
  `),
]);
