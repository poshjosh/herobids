/**
 * Canonical watch types — single source of truth for WatchEntry and related parsing.
 *
 * Used by:
 *   - tools/watch.ts (watch CRUD tools)
 *   - market-intelligence/monitor.ts (threshold evaluation)
 *   - runtime-composition.ts (prompt context via RuntimeActiveWatch)
 */

import { z } from 'zod';
import pino from 'pino';
import type { RuntimeActiveWatch } from './runtime-composition.js';

const logger = pino({ name: 'watch-types' });

// ---------------------------------------------------------------------------
// Instrument identity
// ---------------------------------------------------------------------------

/** Canonical venue + instrument identity resolved from the trading system's instrument repository. */
export interface WatchInstrumentIdentity {
  venue: string;
  instrumentId: string;
  symbol: string;
  chain?: string;
  address?: string;
}

// ---------------------------------------------------------------------------
// Purpose and coverage metadata
// ---------------------------------------------------------------------------

/** Semantic purpose of a watch — tells the runtime what the watch is for. */
export type WatchPurpose = 'entry' | 'exit' | 'stop_loss' | 'take_profit' | 'monitor' | 'alert';

/** Links a watch to a specific actor, position, or intent group for coverage tracking. */
export interface WatchCoverageLink {
  actorType?: 'agent' | 'bot' | 'user' | 'system';
  actorId?: string;
  positionKey?: string;
  intentGroup?: string;
}

// ---------------------------------------------------------------------------
// Canonical WatchEntry
// ---------------------------------------------------------------------------

export interface WatchEntry {
  watchId: string;
  symbol: string;
  chain: string;
  address?: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
  thresholdPrice: number;
  condition: 'above' | 'below';
  note?: string;
  createdAt: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
  /**
   * Schema version discriminator.
   * - undefined or 1: legacy record (created before schemaVersion was introduced)
   * - 2: current (canonical fields, pinned identity support)
   */
  schemaVersion?: number;
  /** Canonical venue + instrument identity, resolved from the trading system's instrument repository. */
  instrument?: WatchInstrumentIdentity;
  /** Semantic purpose — tells the runtime what this watch is for. */
  purpose?: WatchPurpose;
  /** Links this watch to a specific actor, position, or intent group. */
  coverage?: WatchCoverageLink;
}

// ---------------------------------------------------------------------------
// Zod schema — validate at boundaries
// ---------------------------------------------------------------------------

export const WatchEntrySchema = z.object({
  watchId: z.string().uuid(),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  address: z.string().optional(),
  resolvedSymbol: z.string().optional(),
  resolvedChain: z.string().optional(),
  resolvedAddress: z.string().optional(),
  thresholdPrice: z.number().positive(),
  condition: z.enum(['above', 'below']),
  note: z.string().optional(),
  createdAt: z.string().min(1),
  lastConditionMet: z.boolean().nullable(),
  lastCheckedAt: z.string().optional(),
  schemaVersion: z.number().int().positive().optional(),
  instrument: z.object({
    venue: z.string().min(1),
    instrumentId: z.string().min(1),
    symbol: z.string().min(1),
    chain: z.string().optional(),
    address: z.string().optional(),
  }).optional(),
  purpose: z.enum(['entry', 'exit', 'stop_loss', 'take_profit', 'monitor', 'alert']).optional(),
  coverage: z.object({
    actorType: z.enum(['agent', 'bot', 'user', 'system']).optional(),
    actorId: z.string().optional(),
    positionKey: z.string().optional(),
    intentGroup: z.string().optional(),
  }).optional(),
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a WatchEntry.
 *
 * Handles both legacy records (no schemaVersion) and v2 records.
 * Returns null for any malformed or missing data.
 */
export function parseWatch(raw: string): WatchEntry | null {
  try {
    const parsed = WatchEntrySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Try to extract watchId for better diagnostics
      let watchId: string | undefined;
      try {
        const rawObj = JSON.parse(raw) as Record<string, unknown>;
        watchId = typeof rawObj.watchId === 'string' ? rawObj.watchId : undefined;
      } catch { /* swallow */ }
      logger.warn({ watchId, raw: raw.length > 200 ? raw.slice(0, 200) + '...' : raw, errors: parsed.error.issues }, 'Malformed watch record — discarding');
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversion to runtime prompt representation
// ---------------------------------------------------------------------------

/**
 * Convert a WatchEntry into the RuntimeActiveWatch shape used in prompt composition.
 */
export function toRuntimeActiveWatch(watch: WatchEntry): RuntimeActiveWatch {
  return {
    watchId: watch.watchId,
    symbol: watch.symbol,
    chain: watch.chain,
    ...(watch.address ? { address: watch.address } : {}),
    ...(watch.resolvedSymbol ? { resolvedSymbol: watch.resolvedSymbol } : {}),
    ...(watch.resolvedChain ? { resolvedChain: watch.resolvedChain } : {}),
    ...(watch.resolvedAddress ? { resolvedAddress: watch.resolvedAddress } : {}),
    condition: watch.condition,
    thresholdPrice: watch.thresholdPrice,
    note: watch.note,
    lastConditionMet: watch.lastConditionMet,
    lastCheckedAt: watch.lastCheckedAt,
    ...(watch.schemaVersion !== undefined ? { schemaVersion: watch.schemaVersion } : {}),
    ...(watch.instrument ? { instrument: watch.instrument } : {}),
    ...(watch.purpose ? { purpose: watch.purpose } : {}),
    ...(watch.coverage ? { coverage: watch.coverage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the watch entry was created with schema version >= 2.
 */
export function isWatchEntryV2(watch: WatchEntry): boolean {
  return (watch.schemaVersion ?? 0) >= 2;
}
