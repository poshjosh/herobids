// Trading-owned protocol/enums relocated from agent-protocol.ts for trading-layer
// independence (behaviour-preserving; source-fix request
// docs/features/2026/09/07/001-relocate-trading-types-out-of-agent-protocol.md).

import { z } from 'zod';
import {
  AgentWakePayloadBaseSchema,
  ScannerWakeContextSchema,
  WakePrioritySchema,
  type ScannerWakeContext,
  type WakePriority,
} from '@poshjosh/contracts';

// Re-export the package-owned wake shapes so `./agent-protocol.js` importers keep
// working unchanged (the public API surface is preserved).
export { ScannerWakeContextSchema, type ScannerWakeContext, WakePrioritySchema, type WakePriority };

// --- Watch purpose taxonomy ---

export const WATCH_PURPOSE_VALUES = ['entry', 'exit', 'stop_loss', 'take_profit', 'monitor', 'alert'] as const;
export const WatchPurposeEnum = z.enum(WATCH_PURPOSE_VALUES);
export type WatchPurpose = z.infer<typeof WatchPurposeEnum>;

// --- Context snapshot payload ---

export const ContextSnapshotPayloadSchema = z.object({
  snapshotId: z.string().min(1),
  symbol: z.string().min(1),
  price: z.string(),
  timestamp: z.string().datetime(),
  marketData: z.record(z.unknown()).optional(),
  position: z.object({
    side: z.string(),
    size: z.string(),
    entryPrice: z.string(),
    realizedPnl: z.string(),
  }).nullable(),
  /** Per-instrument unrealized PnL in USD. Computed as (markPrice - entryPrice) * size * direction.
   * Used by the runtime tick gate and composition layer for portfolio-level aggregation.
   * Omitted when mark price is unavailable (degraded snapshots). */
  pnl: z.union([z.string(), z.number()]).optional(),
  referenceMark: z.object({
    price: z.string(),
    source: z.string(),
  }),
  strategyParams: z.record(z.unknown()),
  executionMode: z.enum(['paper', 'shadow', 'live']),
  guardrails: z.record(z.unknown()),
  artifacts: z.array(z.record(z.unknown())).optional(),
});

export type ContextSnapshotPayload = z.infer<typeof ContextSnapshotPayloadSchema>;

// --- Source-specific wake context schemas ---

export const ReminderWakeContextSchema = z.object({
  reminderId: z.string().min(1),
  message: z.string().min(1),
  scheduledBy: z.enum(['scout', 'judge']),
  // Repeating-reminder fields. All optional so older one-shot payloads stay valid.
  key: z.string().optional(),
  repeatEveryMs: z.number().int().optional(),
  scheduledFor: z.string().datetime().optional(),
  missedOccurrences: z.number().int().min(0).optional(),
  nextTriggerAt: z.string().datetime().optional(),
});
export type ReminderWakeContext = z.infer<typeof ReminderWakeContextSchema>;

export const WatchThresholdWakeContextSchema = z.object({
  watchId: z.string().min(1),
  symbol: z.string().min(1),
  chain: z.string().min(1),
  condition: z.enum(['above', 'below']),
  thresholdPrice: z.number(),
  currentPrice: z.number(),
  stale: z.boolean(),
  triggeredAt: z.string().datetime(),
  note: z.string().optional(),
  purpose: WatchPurposeEnum.optional(),
  instrumentVenue: z.string().optional(),
  instrumentId: z.string().optional(),
  positionKey: z.string().optional(),
  /** Schema version from the triggering watch entry. Undefined for legacy watches. */
  schemaVersion: z.number().int().positive().optional(),
});
export type WatchThresholdWakeContext = z.infer<typeof WatchThresholdWakeContextSchema>;

export const DiscoveryDeltaWakeContextSchema = z.object({
  symbol: z.string().min(1),
  network: z.string().min(1),
  address: z.string().min(1),
  reason: z.string().min(1),
  rank: z.number().int().optional(),
  liquidityUsd: z.number().optional(),
  volume24hUsd: z.number().optional(),
  detectedAt: z.string().datetime(),
});
export type DiscoveryDeltaWakeContext = z.infer<typeof DiscoveryDeltaWakeContextSchema>;

export const RegimeChangeWakeContextSchema = z.object({
  benchmarkSymbol: z.string().min(1),
  previousState: z.string().min(1),
  currentState: z.string().min(1),
  changedAt: z.string().datetime(),
  details: z.unknown().optional(),
});
export type RegimeChangeWakeContext = z.infer<typeof RegimeChangeWakeContextSchema>;

export const AgentWakePayloadSchema = z.discriminatedUnion('source', [
  AgentWakePayloadBaseSchema.extend({ source: z.literal('reminder'), context: ReminderWakeContextSchema }),
  AgentWakePayloadBaseSchema.extend({ source: z.literal('watch_threshold'), context: WatchThresholdWakeContextSchema }),
  AgentWakePayloadBaseSchema.extend({ source: z.literal('discovery_delta'), context: DiscoveryDeltaWakeContextSchema }),
  AgentWakePayloadBaseSchema.extend({ source: z.literal('regime_change'), context: RegimeChangeWakeContextSchema }),
  AgentWakePayloadBaseSchema.extend({ source: z.literal('scanner'), context: ScannerWakeContextSchema }),
]);

export type AgentWakePayload = z.infer<typeof AgentWakePayloadSchema>;

// --- Trading session windows (relocated from config/schema.ts) ---

export const TRADING_SESSION_NAMES = [
  'asia',
  'london',
  'ny-morning',
  'ny-mid',
  'ny-afternoon',
] as const;
export type TradingSessionName = typeof TRADING_SESSION_NAMES[number];
export const TradingSessionNameSchema = z.enum(TRADING_SESSION_NAMES);
