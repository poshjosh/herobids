import { pgTable, text, timestamp, jsonb, integer, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Persisted scanner candidate observations — the authoritative source for the
 * deterministic review pre-check.
 *
 * Each row captures a single candidate that reached deterministic scoring in a
 * normal technical scan. The review pre-check reads these rows to produce
 * advice without making live market-data or provider requests.
 *
 * `agent_scan_metrics` remains aggregate telemetry and must not be overloaded
 * for per-candidate review advice. Invalid/unresolved candidates are recorded
 * for observability but cannot be advised until canonical resolution succeeds.
 */
export const agentScanCandidates = pgTable('agent_scan_candidates', {
  // ── Primary key ──
  id: text('id').primaryKey(),

  // ── Agent context ──
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),

  // ── Scan metadata ──
  /** When this candidate was observed by the scanner. */
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
  /** Scan/signal calculation version (e.g. the strategy preset version hash). */
  scanVersion: text('scan_version').notNull(),
  /** The agent's active preset key at scan time. */
  activePresetKey: text('active_preset_key').notNull(),
  /** Mechanically-derived behavior version at scan time. */
  presetBehaviorVersion: text('preset_behavior_version').notNull(),

  // ── Canonical identity columns ──
  instrumentKind: text('instrument_kind').notNull(),
  venueFamily: text('venue_family').notNull(),
  styleTier: text('style_tier').notNull(),
  /** Symbol — required for orderbook/perp, null for swap/dex */
  symbol: text('symbol'),
  /** Network (canonical chain id) — required for swap/dex, null for orderbook/perp */
  network: text('network'),
  /** Address (canonical token address) — required for swap/dex, null for orderbook/perp */
  address: text('address'),

  // ── Raw candidate identity ──
  /** The raw instrument identifier from the scanner before canonical resolution. */
  rawCandidateId: text('raw_candidate_id'),
  /** Resolution status for the raw candidate identity.
   *  resolved | unresolved | ambiguous — null when not yet resolved. */
  resolutionStatus: text('resolution_status'),

  // ── Stable candidate metadata ──
  /** 1-based stable rank within the scan. */
  candidateRank: integer('candidate_rank').notNull(),
  /** Scan scope descriptor (e.g. 'default', 'hl_orderbook', 'jupiter_dex'). */
  scanScope: text('scan_scope'),

  // ── Deterministic signal/indicator facts ──
  /**
   * Normalized deterministic facts sufficient to reproduce the review
   * predicate without live market-data or provider requests.
   *
   * Includes at minimum:
   * - signalType (entry_candidate | exit_advisory | scored_no_signal)
   * - indication (bullish | bearish | neutral)
   * - strength score (0-1)
   * - primary indicator name and value
   * - any contributing indicator facts
   */
  signalFacts: jsonb('signal_facts').$type<Record<string, unknown>>(),
  /** Signal confidence (0-1) at scan time. */
  confidence: numeric('confidence'),
  /** Market regime classification at scan time. */
  regimeBucket: text('regime_bucket'),
  /** Volatility fact (e.g. normalized ATR percentile) at scan time. */
  volatilityFact: numeric('volatility_fact'),
  /** When the underlying market data used for this candidate was sourced. */
  dataFreshnessTs: timestamp('data_freshness_ts', { withTimezone: true }),

  // ── Candidate disposition ──
  /**
   * Disposition of this candidate from the scanner:
   * - discovered: scanned but not scored
   * - scored_no_signal: scored but below signal threshold
   * - entry_candidate: scored and generated an entry signal
   * - exit_advisory: scored and generated an exit advisory
   * - rejected: rejected by filters
   * - unresolved: raw identity could not be resolved to canonical form
   */
  disposition: text('disposition').notNull().default('discovered'),

  // ── Lifecycle ──
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_scan_candidates_agent_scanned').on(t.agentId, t.scannedAt),
  index('idx_scan_candidates_identity').on(t.instrumentKind, t.venueFamily, t.styleTier, t.symbol, t.network, t.address),
  index('idx_scan_candidates_rank').on(t.agentId, t.candidateRank),
  index('idx_scan_candidates_disposition').on(t.disposition),
  index('idx_scan_candidates_resolution').on(t.resolutionStatus),
  uniqueIndex('uq_scan_candidates_agent_scan_rank').on(t.agentId, t.scannedAt, t.rawCandidateId),
]);
