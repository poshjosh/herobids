import { pgTable, text, timestamp, jsonb, integer, numeric, index } from 'drizzle-orm/pg-core';

/**
 * Agent scan metrics — per-scan statistics recorded for an agent running a specific preset.
 * These metrics are the phase-1 mandatory primitives for measuring preset signal quality.
 */
export const agentScanMetrics = pgTable('agent_scan_metrics', {
  id: text('id').primaryKey(),
  /** Platform-level scan metrics — not constrained to agents table */
  agentId: text('agent_id').notNull(),
  /** Logical preset family identifier */
  presetKey: text('preset_key').notNull(),
  /** Mechanically-derived behavior version hash */
  presetBehaviorVersion: text('preset_behavior_version').notNull(),
  /** Segment key as JSON: { venueFamily, styleTier, universeScopeHash } */
  segmentKey: jsonb('segment_key').notNull().$type<{
    venueFamily: string;
    styleTier: string;
    universeScopeHash: string;
  }>(),
  /** Denormalized segment key components for efficient querying */
  venueFamily: text('venue_family').notNull(),
  styleTier: text('style_tier').notNull(),
  universeScopeHash: text('universe_scope_hash').notNull(),
  scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
  candidatesDiscovered: integer('candidates_discovered').notNull().default(0),
  candidatesScored: integer('candidates_scored').notNull().default(0),
  signalsGenerated: integer('signals_generated').notNull().default(0),
  scanHealth: text('scan_health').notNull(), // healthy | degraded | no_signal | stale
  topConfidence: numeric('top_confidence'),
  /** Market regime classification at scan time */
  regimeBucket: text('regime_bucket'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_scan_metrics_agent_id').on(t.agentId),
  index('idx_agent_scan_metrics_preset_key').on(t.presetKey),
  index('idx_agent_scan_metrics_scanned_at').on(t.scannedAt),
  index('idx_agent_scan_metrics_segment_key').on(t.segmentKey),
  index('idx_agent_scan_metrics_segment_components').on(t.venueFamily, t.styleTier, t.universeScopeHash),
  index('idx_agent_scan_metrics_preset_scanned_at').on(t.presetKey, t.scannedAt),
]);
