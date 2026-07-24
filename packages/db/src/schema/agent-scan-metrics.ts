import { pgTable, text, timestamp, jsonb, integer, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Agent scan metrics — per-scan statistics recorded for an agent running a specific preset.
 * These metrics are the phase-1 mandatory primitives for measuring preset signal quality.
 *
 * Scan-scope context (venueFamily, styleTier) describes the agent's candidate universe.
 * Per-symbol assessment identity is NOT attached to these aggregate counters.
 */
export const agentScanMetrics = pgTable('agent_scan_metrics', {
  id: text('id').primaryKey(),
  /** Platform-level scan metrics — not constrained to agents table */
  agentId: text('agent_id').notNull(),
  /** Logical preset family identifier */
  presetKey: text('preset_key').notNull(),
  /** Mechanically-derived behavior version hash */
  presetBehaviorVersion: text('preset_behavior_version').notNull(),
  /** Scan-scope context: venue family (e.g. hyperliquid, jupiter) */
  venueFamily: text('venue_family').notNull(),
  /** Scan-scope context: style tier (economy | standard | premium) */
  styleTier: text('style_tier').notNull(),
  /** Additional scan-scope metadata (e.g. filters, universe constraints) */
  scanScope: jsonb('scan_scope').$type<Record<string, unknown>>(),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
  candidatesDiscovered: integer('candidates_discovered').notNull().default(0),
  candidatesScored: integer('candidates_scored').notNull().default(0),
  signalsGenerated: integer('signals_generated').notNull().default(0),
  scanHealth: text('scan_health').notNull(), // healthy_signals | healthy_no_signal | data_path_failure | no_candidates | overlap_skipped
  topConfidence: numeric('top_confidence'),
  /** Market regime classification at scan time */
  regimeBucket: text('regime_bucket'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_scan_metrics_agent_id').on(t.agentId),
  index('idx_agent_scan_metrics_preset_key').on(t.presetKey),
  index('idx_agent_scan_metrics_scanned_at').on(t.scannedAt),
  index('idx_agent_scan_metrics_scan_scope').on(t.venueFamily, t.styleTier),
  index('idx_agent_scan_metrics_preset_scanned_at').on(t.presetKey, t.scannedAt),
]);
