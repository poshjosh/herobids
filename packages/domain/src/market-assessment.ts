import crypto from 'node:crypto';
import { z } from 'zod';
import type { TechnicalConfig } from './config/schema.js';
import type { PriceCandle } from './ports/candle-fetcher.js';
import { err, ok, type Result } from './result.js';

// ── Clean-Slate Cutover Note ────────────────────────────────────────────────
//
// Per D3 (clean-slate database), assessment tables will be reset/initialized as
// part of deployment. There is NO in-place migration of old segment-based data.
// The old `MarketAssessmentSegmentKey` identity model ({venueFamily, styleTier,
// universeScopeHash}) is superseded by the per-symbol `MarketAssessmentIdentity`
// discriminated union below. Old segment helpers (computeUniverseScopeHash,
// createSegmentKey, segmentKeyFromTechnicalConfig) are deprecated and will be
// fully removed once all callers migrate (see implementation checklist §11).
//
// The cutover strategy is:
//   1. Freeze the new canonical identity types (this file).
//   2. Build the new on-demand path alongside the old scheduler.
//   3. Validate end-to-end with the new path.
//   4. Delete the old scheduler and segment code.
//   5. Reset assessment tables to the new schema.
//
// No dual-write period. No backwards-compat mapping of old segment data.

// ── Canonical Assessment Identity (new — replaces segment key) ──────────────

/**
 * Per-symbol canonical assessment identity.
 *
 * Discriminated union: orderbook/perp instruments use `symbol`;
 * swap/dex instruments use `network + address`.
 *
 * This replaces the old `MarketAssessmentSegmentKey` which used
 * `{venueFamily, styleTier, universeScopeHash}` as its identity.
 */
export type MarketAssessmentIdentity =
  | {
      instrumentKind: 'orderbook' | 'perp';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      symbol: string; // normalized, venue-canonical
    }
  | {
      instrumentKind: 'swap' | 'dex';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      network: string; // canonical chain id
      address: string; // canonical token address
    };

export const MarketAssessmentIdentitySchema = z.discriminatedUnion('instrumentKind', [
  z.object({
    instrumentKind: z.enum(['orderbook', 'perp']),
    venueFamily: z.string().min(1),
    styleTier: z.enum(['economy', 'standard', 'premium']),
    symbol: z.string().min(1),
  }),
  z.object({
    instrumentKind: z.enum(['swap', 'dex']),
    venueFamily: z.string().min(1),
    styleTier: z.enum(['economy', 'standard', 'premium']),
    network: z.string().min(1),
    address: z.string().min(1),
  }),
]);

// ── Identity Resolution ─────────────────────────────────────────────────────

/**
 * Normalize and resolve a raw user-provided symbol into a canonical
 * `MarketAssessmentIdentity`.
 *
 * Orderbook/perp path:
 *   - Trims and canonicalizes the symbol against the venue's known symbol set.
 *   - Rejects symbols not in the known set with `unknown_symbol`.
 *
 * Swap/dex path:
 *   - Resolves a user-facing symbol (e.g. "USDC") to canonical
 *     `{network, address}` via the provided token resolution map.
 *   - Falls back to case-insensitive matching when an exact key lookup fails:
 *     a single case-insensitive match resolves successfully; multiple matches
 *     produce `ambiguous_symbol`; zero matches produce `unknown_symbol`.
 *   - Rejects ambiguous or unknown symbols with `ambiguous_symbol` or
 *     `unknown_symbol`.
 *
 * This is the **single** normalization/resolution boundary — all request
 * handling, cache lookup, persistence, billing, and logging must route
 * through this function (or a thin infra wrapper that supplies the
 * venue-specific lookup data).
 */
export function resolveAssessmentIdentity(params: {
  instrumentKind: 'orderbook' | 'perp' | 'swap' | 'dex';
  venueFamily: string;
  styleTier: 'economy' | 'standard' | 'premium';
  symbol: string;
  /** For orderbook/perp: set of known venue symbols (already normalized). */
  knownSymbols?: Set<string>;
  /** For swap/dex: mapping from user-facing symbol to canonical {network, address}. */
  tokenResolutions?: Map<string, { network: string; address: string }>;
}): Result<MarketAssessmentIdentity> {
  const rawSymbol = params.symbol.trim();
  if (rawSymbol.length === 0) {
    return err({
      code: 'assessment.identity.invalid_symbol',
      message: 'Symbol must not be empty',
    });
  }

  switch (params.instrumentKind) {
    case 'orderbook':
    case 'perp': {
      // For venue-specific symbols, case-sensitive matching depends on the venue.
      // We normalise by trimming; the knownSymbols set is expected to already
      // contain venue-canonical forms.
      if (params.knownSymbols && !params.knownSymbols.has(rawSymbol)) {
        return err({
          code: 'assessment.identity.unknown_symbol',
          message: `Symbol "${rawSymbol}" is not recognised for venue family "${params.venueFamily}"`,
          context: { symbol: rawSymbol, venueFamily: params.venueFamily },
        });
      }
      return ok({
        instrumentKind: params.instrumentKind,
        venueFamily: params.venueFamily,
        styleTier: params.styleTier,
        symbol: rawSymbol,
      });
    }
    case 'swap':
    case 'dex': {
      if (!params.tokenResolutions || params.tokenResolutions.size === 0) {
        return err({
          code: 'assessment.identity.no_token_resolutions',
          message: `No token resolution data available for venue family "${params.venueFamily}"`,
        });
      }
      const resolution = params.tokenResolutions.get(rawSymbol);
      if (!resolution) {
        // Check for partial/ambiguous matches
        const lowerSymbol = rawSymbol.toLowerCase();
        const matches = [...params.tokenResolutions.entries()].filter(
          ([key]) => key.toLowerCase() === lowerSymbol,
        );
        if (matches.length > 1) {
          return err({
            code: 'assessment.identity.ambiguous_symbol',
            message: `Symbol "${rawSymbol}" matches multiple tokens on "${params.venueFamily}". Provide a more specific identifier.`,
            context: { symbol: rawSymbol, venueFamily: params.venueFamily, matchCount: matches.length },
          });
        }
        if (matches.length === 1 && matches[0]) {
          return ok({
            instrumentKind: params.instrumentKind,
            venueFamily: params.venueFamily,
            styleTier: params.styleTier,
            network: matches[0][1].network,
            address: matches[0][1].address,
          });
        }
        return err({
          code: 'assessment.identity.unknown_symbol',
          message: `Symbol "${rawSymbol}" could not be resolved to a token on "${params.venueFamily}"`,
          context: { symbol: rawSymbol, venueFamily: params.venueFamily },
        });
      }
      return ok({
        instrumentKind: params.instrumentKind,
        venueFamily: params.venueFamily,
        styleTier: params.styleTier,
        network: resolution.network,
        address: resolution.address,
      });
    }
    default: {
      const _exhaustive: never = params.instrumentKind;
      return err({
        code: 'assessment.identity.unsupported_instrument_kind',
        message: `Unsupported instrument kind: ${String(_exhaustive)}`,
      });
    }
  }
}

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
 *
 * @deprecated Removed in the per-symbol on-demand assessment model (Step 9).
 *   `universeScopeHash` is no longer an assessment-identity dimension.
 *   Use `MarketAssessmentIdentity` and `resolveAssessmentIdentity()` instead.
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
 *
 * @deprecated Removed in the per-symbol on-demand assessment model (Step 9).
 *   Segment keys are replaced by `MarketAssessmentIdentity`.
 *   Use `resolveAssessmentIdentity()` instead.
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
 *
 * @deprecated Removed in the per-symbol on-demand assessment model (Step 9).
 *   Segment keys are replaced by `MarketAssessmentIdentity`.
 *   Use `resolveAssessmentIdentity()` instead.
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

// ── Transition State Machine ────────────────────────────────────────────────

/**
 * Valid state transitions for the platform-owned side.
 */
const VALID_PLATFORM_TRANSITIONS: Record<PlatformTransitionState, PlatformTransitionState[]> = {
  assessment_available: ['wake_suppressed', 'wake_emitted'],
  wake_suppressed: [],
  wake_emitted: [],
};

/**
 * Valid state transitions for the actor-owned side.
 */
const VALID_ACTOR_TRANSITIONS: Record<ActorTransitionState, ActorTransitionState[]> = {
  actor_reviewed: ['transition_recommended', 'transition_deferred', 'transition_rejected'],
  transition_recommended: ['transition_applied', 'transition_deferred', 'transition_rejected', 'transition_expired'],
  transition_applied: [],
  transition_deferred: [],
  transition_rejected: [],
  transition_expired: [],
};

/**
 * Returns true if the transition from `from` to `to` is valid per the state machine.
 */
export function isValidTransition(from: TransitionState, to: TransitionState): boolean {
  if (from in VALID_PLATFORM_TRANSITIONS) {
    return VALID_PLATFORM_TRANSITIONS[from as PlatformTransitionState]?.includes(to as PlatformTransitionState) ?? false;
  }
  if (from in VALID_ACTOR_TRANSITIONS) {
    return VALID_ACTOR_TRANSITIONS[from as ActorTransitionState]?.includes(to as ActorTransitionState) ?? false;
  }
  return false;
}

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
  /** @deprecated Removed in per-symbol on-demand model — use canonical identity columns instead. */
  segmentKey?: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  /** @deprecated Removed in per-symbol on-demand model. */
  universeScopeHash?: string;
  startedAt: string; // ISO 8601
  completedAt: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'budget_exhausted';
  evidenceRefs: string[];
  errorMessage: string | null;
  assessmentVersion: number;
}

export const MarketAssessmentRunSchema = z.object({
  id: z.string().min(1),
  segmentKey: MarketAssessmentSegmentKeySchema.optional(),
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1).optional(),
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
  /** @deprecated Removed in per-symbol on-demand model — use canonical identity columns instead. */
  segmentKey?: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  /** @deprecated Removed in per-symbol on-demand model. */
  universeScopeHash?: string;
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
  segmentKey: MarketAssessmentSegmentKeySchema.optional(),
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1).optional(),
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
  /** @deprecated Removed in per-symbol on-demand model — use canonical identity columns instead. */
  segmentKey?: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  /** @deprecated Removed in per-symbol on-demand model. */
  universeScopeHash?: string;
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
  segmentKey: MarketAssessmentSegmentKeySchema.optional(),
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1).optional(),
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
  /** @deprecated Removed in per-symbol on-demand model — use canonical identity columns instead. */
  segmentKey?: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  /** @deprecated Removed in per-symbol on-demand model. */
  universeScopeHash?: string;
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
  segmentKey: MarketAssessmentSegmentKeySchema.optional(),
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1).optional(),
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
  /** @deprecated Removed in per-symbol on-demand model — use canonical identity columns instead. */
  segmentKey?: MarketAssessmentSegmentKey;
  /** Denormalized segment key components for efficient querying */
  venueFamily: string;
  styleTier: string;
  /** @deprecated Removed in per-symbol on-demand model. */
  universeScopeHash?: string;
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
  segmentKey: MarketAssessmentSegmentKeySchema.optional(),
  venueFamily: z.string().min(1),
  styleTier: z.string().min(1),
  universeScopeHash: z.string().min(1).optional(),
  mode: z.enum(['shadow', 'live']),
  transitionMode: TransitionModeSchema,
  openPositionCount: z.number().int().nonnegative(),
  outcome: z.enum(['accepted', 'deferred', 'rejected']),
  reason: z.string().nullable(),
  appliedAt: z.string().datetime(),
  regimeSnapshot: z.record(z.unknown()).nullable(),
});

// ── Artifact Freshness & Staleness ──────────────────────────────────────────

/**
 * Check if an artifact is still fresh (not expired and not superseded).
 * Accepts a minimal shape so callers do not need the full artifact type,
 * avoiding dependency on deprecated segment-key fields.
 */
export function isArtifactFresh(artifact: { status: string; expiresAt: string }, now?: Date): boolean {
  const nowDate = now ?? new Date();
  const expiresAt = new Date(artifact.expiresAt);
  return artifact.status === 'active' && nowDate < expiresAt;
}

/**
 * Check if an artifact is stale (expired or superseded).
 */
export function isArtifactStale(artifact: { status: string; expiresAt: string }, now?: Date): boolean {
  return !isArtifactFresh(artifact, now);
}

/**
 * Check if an artifact is fresh enough to trigger a review wake.
 * Stricter than general freshness — uses maxWakeAge.
 */
export function canTriggerWake(artifact: MarketAssessmentArtifact, now?: Date): boolean {
  if (!isArtifactFresh(artifact, now)) return false;
  const nowDate = now ?? new Date();
  const wakeDeadline = new Date(artifact.maxWakeAge);
  return nowDate < wakeDeadline;
}

/**
 * Check if an artifact is fresh enough for an actor to use for a transition decision.
 * Uses maxActorUseAge which may be looser than maxWakeAge.
 */
export function canUseForTransition(artifact: MarketAssessmentArtifact, now?: Date): boolean {
  if (!isArtifactFresh(artifact, now)) return false;
  const nowDate = now ?? new Date();
  const useDeadline = new Date(artifact.maxActorUseAge);
  return nowDate < useDeadline;
}

/**
 * Determine the freshness reason for observability.
 */
export type ArtifactFreshnessStatus =
  | 'fresh'
  | 'stale_expired'
  | 'stale_superseded'
  | 'stale_for_wake'
  | 'stale_for_transition';

export function getArtifactFreshnessStatus(
  artifact: MarketAssessmentArtifact,
  now?: Date,
): ArtifactFreshnessStatus {
  if (artifact.status === 'superseded') return 'stale_superseded';
  if (isArtifactStale(artifact, now)) return 'stale_expired';
  if (!canTriggerWake(artifact, now)) return 'stale_for_wake';
  if (!canUseForTransition(artifact, now)) return 'stale_for_transition';
  return 'fresh';
}

// ── Evidence & Scorecard Types ──────────────────────────────────────────────

/**
 * Market regime assessment result.
 *
 * Defined here (not imported from @herobids/market-data) because the domain
 * package must remain dependency-free per ports-and-adapters architecture.
 * The canonical source is packages/market-data/src/types.ts; this copy must
 * stay structurally identical.
 */
export interface RegimeResult {
  pass: boolean;
  reasons: string[];
  details: {
    benchmarkSymbol: string;
    currentPrice: number;
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
    emaAlignment: 'bullish' | 'bearish';
    adxValue: number;
    choppy: boolean;
    vwap: number;
    priceAboveVwap: boolean;
    marketStructure: 'higherHighs' | 'lowerHighs' | 'mixed';
  };
}

export const RegimeResultSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
  details: z.object({
    benchmarkSymbol: z.string(),
    currentPrice: z.number(),
    emaFast: z.number(),
    emaSlow: z.number(),
    emaTrend: z.number(),
    emaAlignment: z.enum(['bullish', 'bearish']),
    adxValue: z.number(),
    choppy: z.boolean(),
    vwap: z.number(),
    priceAboveVwap: z.boolean(),
    marketStructure: z.enum(['higherHighs', 'lowerHighs', 'mixed']),
  }),
});

// ── PriceCandle schema (domain-local; interface lives in ports/candle-fetcher.ts) ─

const PriceCandleSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

// ── EvidenceValue<T> ────────────────────────────────────────────────────────

/**
 * Versioned, auditable evidence wrapper.
 *
 * Evidence is either available (with a typed value, source, and expiry) or
 * unavailable (with a reason code and message for observability).
 */
export type EvidenceValue<T> =
  | {
      state: 'available';
      value: T;
      source: string;
      observedAt: string;
      expiresAt: string;
    }
  | {
      state: 'unavailable';
      reasonCode: string;
      message: string;
      observedAt: string;
    };

/**
 * Create a Zod schema for EvidenceValue<T> given a value schema for T.
 */
export function EvidenceValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('state', [
    z.object({
      state: z.literal('available'),
      value: valueSchema,
      source: z.string(),
      observedAt: z.string(),
      expiresAt: z.string(),
    }),
    z.object({
      state: z.literal('unavailable'),
      reasonCode: z.string(),
      message: z.string(),
      observedAt: z.string(),
    }),
  ]);
}

// ── VolatilityEvidence ──────────────────────────────────────────────────────

export interface VolatilityEvidence {
  averageTrueRange: number;
  volatilityRegime: 'low' | 'normal' | 'high' | 'extreme';
  calculationVersion: string;
}

export const VolatilityEvidenceSchema = z.object({
  averageTrueRange: z.number().nonnegative(),
  volatilityRegime: z.enum(['low', 'normal', 'high', 'extreme']),
  calculationVersion: z.string().min(1),
});

// ── LiquidityEvidence ───────────────────────────────────────────────────────

export interface LiquidityEvidence {
  averageSpreadBps: number;
  averageDepthUsd: number;
  quality: 'good' | 'adequate' | 'poor';
}

export const LiquidityEvidenceSchema = z.object({
  averageSpreadBps: z.number().nonnegative(),
  averageDepthUsd: z.number().nonnegative(),
  quality: z.enum(['good', 'adequate', 'poor']),
});

// ── BreadthEvidence ─────────────────────────────────────────────────────────

export interface BreadthEvidence {
  symbolsAboveMA: number;
  totalSymbols: number;
  breadthRatio: number;
}

export const BreadthEvidenceSchema = z.object({
  symbolsAboveMA: z.number().int().nonnegative(),
  totalSymbols: z.number().int().positive(),
  breadthRatio: z.number().min(0).max(1),
});

// ── ScorecardInput ──────────────────────────────────────────────────────────

export interface ScorecardInput {
  symbol: string;
  candleWindow: { start: string; end: string };
  candlesAvailable: number;
}

export const ScorecardInputSchema = z.object({
  symbol: z.string().min(1),
  candleWindow: z.object({
    start: z.string(),
    end: z.string(),
  }),
  candlesAvailable: z.number().int().nonnegative(),
});

// ── AssessmentData<T> ───────────────────────────────────────────────────────

export interface AssessmentData<T> {
  data: T;
  source: string;
  provider: string;
  observedAt: string;
  expiresAt: string;
}

export function AssessmentDataSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    source: z.string(),
    provider: z.string(),
    observedAt: z.string(),
    expiresAt: z.string(),
  });
}

// ── AssessmentUnavailable ───────────────────────────────────────────────────

export interface AssessmentUnavailable {
  reasonCode: string;
  message: string;
  observedAt: string;
}

export const AssessmentUnavailableSchema = z.object({
  reasonCode: z.string(),
  message: z.string(),
  observedAt: z.string(),
});

// ── AssessmentMarketCohort ──────────────────────────────────────────────────

export interface AssessmentMarketCohort {
  venueFamily: string;
  instrumentKind: string;
  symbols: string[];
  lookback: number;
  membershipTimestamp: string;
  movingAveragePolicy: '50' | '200';
}

export const AssessmentMarketCohortSchema = z.object({
  venueFamily: z.string().min(1),
  instrumentKind: z.string().min(1),
  symbols: z.array(z.string()),
  lookback: z.number().int().positive(),
  membershipTimestamp: z.string(),
  movingAveragePolicy: z.enum(['50', '200']),
});

// ── AssessmentEvidenceSnapshot ──────────────────────────────────────────────

export interface AssessmentEvidenceSnapshot {
  schemaVersion: 1;
  identity: MarketAssessmentIdentity;
  collectedAt: string;
  regime: EvidenceValue<RegimeResult>;
  symbolCandles: EvidenceValue<ReadonlyArray<PriceCandle>>;
  volatility: EvidenceValue<VolatilityEvidence>;
  liquidity: EvidenceValue<LiquidityEvidence>;
  breadth: EvidenceValue<BreadthEvidence>;
  scorecardInput: EvidenceValue<ScorecardInput>;
}

export const AssessmentEvidenceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  identity: MarketAssessmentIdentitySchema,
  collectedAt: z.string(),
  regime: EvidenceValueSchema(RegimeResultSchema),
  symbolCandles: EvidenceValueSchema(z.array(PriceCandleSchema)),
  volatility: EvidenceValueSchema(VolatilityEvidenceSchema),
  liquidity: EvidenceValueSchema(LiquidityEvidenceSchema),
  breadth: EvidenceValueSchema(BreadthEvidenceSchema),
  scorecardInput: EvidenceValueSchema(ScorecardInputSchema),
});
