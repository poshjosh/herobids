import crypto from 'node:crypto';
import { z } from 'zod';
import type { TechnicalConfig } from './config/schema.js';

// ── Segment Key (D1 from decision record) ───────────────────────────────────

/**
 * Shared market-assessment segment key.
 * Assessments are partitioned by this key so that agents sharing the
 * same venue family, style tier, and discovery scope reuse one artifact.
 */
export interface MarketAssessmentSegmentKey {
  venueFamily: string; // e.g. 'hyperliquid-orderbook', 'bybit-orderbook'
  styleTier: 'economy' | 'standard' | 'premium';
  universeScopeHash: string; // hash of normalized discovery-relevant filters
}

export const MarketAssessmentSegmentKeySchema = z.object({
  venueFamily: z.string().min(1),
  styleTier: z.enum(['economy', 'standard', 'premium']),
  universeScopeHash: z.string().min(1),
});

// ── Segment Key Construction ────────────────────────────────────────────────

/**
 * Compute a deterministic hash of the discovery-relevant filters that define
 * the shared candidate population for a segment.
 *
 * Included: venue family/type, volume/liquidity filters, networks, symbol
 * allowlists/denylists, and any other filter that changes the candidate set.
 *
 * Excluded: open positions, risk limits, capital, current preset, recent PnL,
 * actor-specific transition policy.
 */
export function computeUniverseScopeHash(params: {
  venueFamily: string;
  venueType?: string;
  minVolume24hUsd?: number;
  minLiquidityUsd?: number;
  networks?: string[];
  symbols?: string[];
  excludeSymbols?: string[];
}): string {
  const normalized = {
    venueFamily: params.venueFamily,
    venueType: params.venueType ?? null,
    minVolume24hUsd: (params.minVolume24hUsd && params.minVolume24hUsd > 0) ? params.minVolume24hUsd : null,
    minLiquidityUsd: (params.minLiquidityUsd && params.minLiquidityUsd > 0) ? params.minLiquidityUsd : null,
    networks: params.networks ? [...params.networks].sort() : null,
    symbols: params.symbols ? [...params.symbols].sort() : null,
    excludeSymbols: params.excludeSymbols ? [...params.excludeSymbols].sort() : null,
  };
  const canonical = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Create a full segment key from venue family, style tier, and discovery filters.
 */
export function createSegmentKey(params: {
  venueFamily: string;
  styleTier: 'economy' | 'standard' | 'premium';
  venueType?: string;
  minVolume24hUsd?: number;
  minLiquidityUsd?: number;
  networks?: string[];
  symbols?: string[];
  excludeSymbols?: string[];
}): MarketAssessmentSegmentKey {
  return {
    venueFamily: params.venueFamily,
    styleTier: params.styleTier,
    universeScopeHash: computeUniverseScopeHash(params),
  };
}

/**
 * Derive a segment key from an agent's technical configuration filters.
 */
export function segmentKeyFromTechnicalConfig(
  config: TechnicalConfig,
  styleTier: 'economy' | 'standard' | 'premium',
): MarketAssessmentSegmentKey {
  return createSegmentKey({
    venueFamily: `${config.filters.venue}-${config.filters.venueType}`,
    styleTier,
    venueType: config.filters.venueType,
    minVolume24hUsd: config.filters.minVolume24hUsd,
    minLiquidityUsd: config.filters.minLiquidityUsd,
    networks: config.filters.networks,
    symbols: config.filters.symbols,
    excludeSymbols: config.filters.excludeSymbols,
  });
}

// ── Transition States ───────────────────────────────────────────────────────

/** Platform-owned state: has an assessment artifact been created for this segment, and has a wake been emitted? */
export type PlatformTransitionState =
  | 'assessment_available'
  | 'wake_suppressed'
  | 'wake_emitted';

/** Actor-owned state: what has the agent done with a transition recommendation? */
export type ActorTransitionState =
  | 'actor_reviewed'
  | 'transition_recommended'
  | 'transition_applied'
  | 'transition_deferred'
  | 'transition_rejected'
  | 'transition_expired';

export type TransitionState = PlatformTransitionState | ActorTransitionState;

// ── Transition Mode (D12) ───────────────────────────────────────────────────

/** How existing positions are handled during a preset switch. */
export type TransitionMode = 'entries_only' | 'entries_and_tighten_existing' | 'entries_and_full_transition';

export const TransitionModeSchema = z.enum([
  'entries_only',
  'entries_and_tighten_existing',
  'entries_and_full_transition',
]);

// ── Preset Scorecard ────────────────────────────────────────────────────────

/** Per-preset dry-run result from the deterministic shared scanner. */
export interface PresetScorecardEntry {
  presetKey: string;
  presetBehaviorVersion: string;
  candidatesDiscovered: number;
  candidatesScored: number;
  signalsGenerated: number;
  topConfidence: number | null;
  scanHealth: 'healthy' | 'degraded' | 'no_signal' | 'stale';
}

export const PresetScorecardEntrySchema = z.object({
  presetKey: z.string().min(1),
  presetBehaviorVersion: z.string().min(1),
  candidatesDiscovered: z.number().int().nonnegative(),
  candidatesScored: z.number().int().nonnegative(),
  signalsGenerated: z.number().int().nonnegative(),
  topConfidence: z.number().min(0).max(1).nullable(),
  scanHealth: z.enum(['healthy', 'degraded', 'no_signal', 'stale']),
});

// ── Preset Ranking ──────────────────────────────────────────────────────────

/** Preset ranking entry within a market-assessment artifact. */
export interface MarketAssessmentPresetRanking {
  presetKey: string;
  presetBehaviorVersion: string;
  rank: number;
  score: number;
  scoreBand: string; // normalized percentile band
  pros: string[];
  cons: string[];
  fitNotes: string | null;
}

export const MarketAssessmentPresetRankingSchema = z.object({
  presetKey: z.string().min(1),
  presetBehaviorVersion: z.string().min(1),
  rank: z.number().int().positive(),
  score: z.number(),
  scoreBand: z.string().min(1),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  fitNotes: z.string().nullable(),
});

// ── Market Assessment Run ───────────────────────────────────────────────────

/** A platform-owned assessment execution for a segment. */
export interface MarketAssessmentRun {
  id: string;
  segmentKey: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  universeScopeHash: string;
  startedAt: string; // ISO 8601
  completedAt: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'budget_exhausted';
  evidenceRefs: string[];
  errorMessage: string | null;
  assessmentVersion: number;
}

export const MarketAssessmentRunSchema = z.object({
  id: z.string().min(1),
  segmentKey: MarketAssessmentSegmentKeySchema,
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'budget_exhausted']),
  evidenceRefs: z.array(z.string()),
  errorMessage: z.string().nullable(),
  assessmentVersion: z.number().int().positive(),
});

// ── Market Assessment Artifact ──────────────────────────────────────────────

/** Cached shared assessment artifact for a market segment. */
export interface MarketAssessmentArtifact {
  id: string;
  segmentKey: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  universeScopeHash: string;
  assessmentRunId: string;
  assessedAt: string; // ISO 8601
  expiresAt: string; // ISO 8601
  maxActorUseAge: string; // ISO 8601 or duration
  maxWakeAge: string; // ISO 8601 or duration
  assessmentVersion: number;
  artifactVersion: number;
  rankingPolicyVersion: number;
  /** Lifecycle status: active | expired | superseded */
  status: 'active' | 'expired' | 'superseded';
  allowedPresets: string[]; // presetKeys
  currentMarketSummary: string;
  regimeSummary: string;
  scanHealthSummary: string;
  presetRankings: MarketAssessmentPresetRanking[];
  recommendedPreset: string | null;
  relativeUplift: number | null;
  confidence: number; // 0-1
  urgency: 'low' | 'medium' | 'high';
  reasoningSummary: string;
  evidenceRefs: string[];
}

export const MarketAssessmentArtifactSchema = z.object({
  id: z.string().min(1),
  segmentKey: MarketAssessmentSegmentKeySchema,
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1),
  assessmentRunId: z.string().min(1),
  assessedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxActorUseAge: z.string().min(1),
  maxWakeAge: z.string().min(1),
  assessmentVersion: z.number().int().positive(),
  artifactVersion: z.number().int().nonnegative(),
  rankingPolicyVersion: z.number().int().nonnegative(),
  status: z.enum(['active', 'expired', 'superseded']),
  allowedPresets: z.array(z.string()),
  currentMarketSummary: z.string(),
  regimeSummary: z.string(),
  scanHealthSummary: z.string(),
  presetRankings: z.array(MarketAssessmentPresetRankingSchema),
  recommendedPreset: z.string().nullable(),
  relativeUplift: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  urgency: z.enum(['low', 'medium', 'high']),
  reasoningSummary: z.string(),
  evidenceRefs: z.array(z.string()),
});

// ── Wake Gate Decision ──────────────────────────────────────────────────────

/** A platform wake-gate decision for a specific agent and assessment artifact. */
export interface MarketAssessmentWakeDecision {
  id: string;
  assessmentArtifactId: string;
  agentId: string;
  segmentKey: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  universeScopeHash: string;
  decidedAt: string;
  decision: 'wake_emitted' | 'wake_suppressed';
  suppressionReason: string | null;
  scoreUplift: number | null;
  confidence: number;
  agentCurrentPreset: string;
  recommendedPreset: string;
}

export const MarketAssessmentWakeDecisionSchema = z.object({
  id: z.string().min(1),
  assessmentArtifactId: z.string().min(1),
  agentId: z.string().min(1),
  segmentKey: MarketAssessmentSegmentKeySchema,
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1),
  decidedAt: z.string().datetime(),
  decision: z.enum(['wake_emitted', 'wake_suppressed']),
  suppressionReason: z.string().nullable(),
  scoreUplift: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  agentCurrentPreset: z.string().min(1),
  recommendedPreset: z.string().min(1),
});

// ── Agent Scan Metrics ──────────────────────────────────────────────────────

/** Per-scan metrics recorded for an agent running a specific preset. */
export interface AgentScanMetrics {
  id: string;
  agentId: string;
  presetKey: string;
  presetBehaviorVersion: string;
  segmentKey: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  universeScopeHash: string;
  scannedAt: string;
  candidatesDiscovered: number;
  candidatesScored: number;
  signalsGenerated: number;
  scanHealth: 'healthy' | 'degraded' | 'no_signal' | 'stale';
  topConfidence: number | null;
  regimeBucket: string | null;
}

export const AgentScanMetricsSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  presetKey: z.string().min(1),
  presetBehaviorVersion: z.string().min(1),
  segmentKey: MarketAssessmentSegmentKeySchema,
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1),
  scannedAt: z.string().datetime(),
  candidatesDiscovered: z.number().int().nonnegative(),
  candidatesScored: z.number().int().nonnegative(),
  signalsGenerated: z.number().int().nonnegative(),
  scanHealth: z.enum(['healthy', 'degraded', 'no_signal', 'stale']),
  topConfidence: z.number().min(0).max(1).nullable(),
  regimeBucket: z.string().nullable(),
});

// ── Agent Preset Transition ─────────────────────────────────────────────────

/** A recorded preset-switch event for an agent. */
export interface AgentPresetTransition {
  id: string;
  agentId: string;
  oldPresetKey: string;
  oldPresetBehaviorVersion: string;
  newPresetKey: string;
  newPresetBehaviorVersion: string;
  assessmentArtifactId: string | null;
  segmentKey: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  universeScopeHash: string;
  /** Execution mode: shadow | live */
  mode: 'shadow' | 'live';
  transitionMode: TransitionMode;
  openPositionCount: number;
  outcome: 'accepted' | 'deferred' | 'rejected';
  reason: string | null;
  appliedAt: string;
  regimeSnapshot: Record<string, unknown> | null;
}

export const AgentPresetTransitionSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  oldPresetKey: z.string().min(1),
  oldPresetBehaviorVersion: z.string().min(1),
  newPresetKey: z.string().min(1),
  newPresetBehaviorVersion: z.string().min(1),
  assessmentArtifactId: z.string().nullable(),
  segmentKey: MarketAssessmentSegmentKeySchema,
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1),
  mode: z.enum(['shadow', 'live']),
  transitionMode: TransitionModeSchema,
  openPositionCount: z.number().int().nonnegative(),
  outcome: z.enum(['accepted', 'deferred', 'rejected']),
  reason: z.string().nullable(),
  appliedAt: z.string().datetime(),
  regimeSnapshot: z.record(z.unknown()).nullable(),
});
