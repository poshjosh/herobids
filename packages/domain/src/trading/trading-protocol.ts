// Trading-owned protocol/enums relocated from agent-protocol.ts for trading-layer
// independence (behaviour-preserving; source-fix request
// docs/features/2026/09/07/001-relocate-trading-types-out-of-agent-protocol.md).

import { z } from 'zod';
import { MarketAssessmentIdentitySchema } from '../market-assessment.js';

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

export const ScannerWakeContextSchema = z.discriminatedUnion('scannerKind', [
  z.object({
    scannerKind: z.literal('signal_scoring'),
    signalCount: z.number().int().min(0),
    topSymbol: z.string().optional(),
    topConfidence: z.number().min(0).max(1).optional(),
    regimePass: z.boolean().nullable().optional(),
  }),
  z.object({
    scannerKind: z.literal('preset_review'),
    /** Reference to the market assessment artifact that triggered this review. */
    assessmentRef: z.string().min(1),
    /** The preset key recommended by the platform assessor. */
    recommendedPreset: z.string().min(1),
    /** The agent's current preset key at the time of the assessment. */
    currentPreset: z.string().min(1),
    /** The relative score uplift of the recommended preset over the current one. Must be non-negative. */
    relativeUplift: z.number().min(0),
    /** The platform assessor's confidence in the recommendation (0-1). */
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    scannerKind: z.literal('assessment_review'),
    /** Bounded advice list — at most one entry per canonical identity. */
    advice: z.array(z.object({
      /** Canonical per-symbol identity for the advised candidate. */
      identity: MarketAssessmentIdentitySchema,
      /** Position in the deterministic scanner ranking (1-based). */
      candidateRank: z.number().int().min(1),
      /** The agent's active preset key at check time. */
      activePreset: z.string().min(1),
      /** Mechanically-derived behavior version at check time. */
      presetBehaviorVersion: z.string().min(1),
      /** Deterministic reason(s) the candidate was advised — cheap facts only, no LLM. */
      reasons: z.array(z.string().min(1)).min(1),
      /** The market assessment artifact ID, if a synchronous assessment was performed. */
      assessmentArtifactId: z.string().min(1).optional(),
      /** The preset key recommended by the platform assessor, if available. */
      recommendedPreset: z.string().min(1).nullable().optional(),
      /** The platform assessor's confidence (0-1), if available. */
      confidence: z.number().min(0).max(1).optional(),
      /** When the assessment artifact expires, if available. */
      expiresAt: z.string().datetime().optional(),
    })).min(1),
    /** When the deterministic pre-check ran. */
    checkedAt: z.string().datetime(),
    /** When the next review is eligible. */
    nextEligibleAt: z.string().datetime(),
  }),
]);
export type ScannerWakeContext = z.infer<typeof ScannerWakeContextSchema>;

// `WakePrioritySchema` moved here alongside its sole consumer `AgentWakePayloadBaseSchema`
// to keep this module self-contained and avoid a runtime import cycle with agent-protocol.ts.
// Re-exported from agent-protocol.ts so the public API surface is unchanged.
export const WakePrioritySchema = z.enum(['low', 'normal', 'high']);
export type WakePriority = z.infer<typeof WakePrioritySchema>;

const AgentWakePayloadBaseSchema = z.object({
  wakeId: z.string().min(1),
  reason: z.string().min(1),
  eventIds: z.array(z.string().min(1)),
  priority: WakePrioritySchema,
  requestedAt: z.string().datetime(),
  notBefore: z.string().datetime().optional(),
});

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
