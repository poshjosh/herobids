// TODO(009): Wire PresetScorecardRunner into PlatformAssessor.generateScorecards()

import type { MarketAssessmentIdentity, PresetEntry, PresetScorecardEntry, PriceCandle, TradertonReadResult } from '@herobids/domain';
import { computePresetBehaviorVersion, err, ok, type Result } from '@herobids/domain';
import type { IndicatorConfig, ScanConfig } from './preset-scan-contracts.js';

// ── Deps ────────────────────────────────────────────────────────────────────

/**
 * The narrow `score_candidate` read-boundary port the runner consumes for ALL
 * scoring — orderbook/perp AND swap/dex (the swap arm now routes over the
 * boundary too; the boundary resolves the token → pool behind it). Structurally
 * identical to the read tools' `ctx.tradertonBoundary`; the composition root
 * binds a SYSTEM subject + deadline. When absent, scoring cannot proceed (the
 * caller supplies it; the assessor threads one from the worker composition root).
 */
export interface ScoreCandidateBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

export interface PresetScorecardRunnerDeps {
  /**
   * The `score_candidate` boundary for ALL scoring — orderbook/perp and swap/dex.
   * The boundary fetches candles (and, for swap, resolves the token → pool) behind
   * itself. Optional so unit tests can assert the boundary-unavailable degrade.
   */
  scoreCandidateBoundary?: ScoreCandidateBoundary;
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface PresetScorecardRunner {
  /**
   * Generate deterministic scorecards for all presets in a style tier.
   *
   * ALL presets are scored over the Traderton `score_candidate` boundary. For
   * orderbook/perp the boundary fetches candles from the provider symbol; for
   * swap/dex it resolves the token (network + address) → its canonical pool and
   * scores that pool's candles — all behind the boundary. Returns an error
   * Result when the boundary reports an infrastructure failure so the caller can
   * propagate it (never synthesizing a fake scan-health).
   *
   * `candles` is retained on the signature for the (unchanged) public shape but
   * is no longer consumed — the boundary owns candle fetching for every arm.
   */
  generateScorecards(params: {
    identity: MarketAssessmentIdentity;
    presets: Array<{ key: string; entry: PresetEntry }>;
    candles: PriceCandle[];
  }): Promise<Result<PresetScorecardEntry[]>>;
}

// ── Implementation ──────────────────────────────────────────────────────────

export class PresetScorecardRunnerImpl implements PresetScorecardRunner {
  private readonly scoreCandidateBoundary: ScoreCandidateBoundary | undefined;

  constructor(deps: PresetScorecardRunnerDeps) {
    this.scoreCandidateBoundary = deps.scoreCandidateBoundary;
  }

  async generateScorecards(params: {
    identity: MarketAssessmentIdentity;
    presets: Array<{ key: string; entry: PresetEntry }>;
    candles: PriceCandle[];
  }): Promise<Result<PresetScorecardEntry[]>> {
    const { identity, presets } = params;
    const symbol = resolveSymbol(identity);
    const isOrderbookLike =
      identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp';
    const output: PresetScorecardEntry[] = [];

    for (const { key: presetKey, entry: preset } of presets) {
      // Skip DCA presets — they are bot-only and not scorable by the scan engine.
      if (preset.strategy.type === 'dca') continue;

      const presetBehaviorVersion = computePresetBehaviorVersion(preset);
      const indicatorConfig = extractIndicatorConfig(preset);
      const signalBias = extractSignalBias(preset);
      const scanConfig: ScanConfig = {
        indicators: indicatorConfig,
        signalBias,
      };

      // Build the venue-specific `score_candidate` payload, then score over the
      // boundary. Orderbook/perp pass a provider symbol; swap/dex pass the token
      // identity (network + tokenAddress) and the boundary resolves the pool.
      const payload = isOrderbookLike
        ? {
            // The boundary fetches candles itself from the identifiers; providerSymbol
            // = identity.symbol reproduces the old in-process behaviour by construction
            // (the old path passed identity.symbol as the candidate symbol).
            symbol,
            instrumentId: symbol,
            venueType: 'orderbook' as const,
            providerSymbol: symbol,
            venue: identity.venueFamily,
            config: scanConfig,
          }
        : {
            // Swap/dex: pass only the token identity the runner already has; the
            // boundary resolves network + tokenAddress → the canonical pool, then
            // scores that pool's candles (token→pool lookup stays behind the boundary).
            symbol,
            instrumentId: symbol,
            venueType: 'swap' as const,
            network: (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>).network,
            tokenAddress: (identity as Extract<MarketAssessmentIdentity, { instrumentKind: 'swap' | 'dex' }>).address,
            venue: identity.venueFamily,
            config: scanConfig,
          };

      const entryResult = await this.scoreViaBoundary({
        payload,
        presetKey,
        presetBehaviorVersion,
      });

      if (!entryResult.ok) {
        return entryResult;
      }
      output.push(entryResult.data);
    }

    return ok(output);
  }

  /**
   * Score a candidate over the `score_candidate` boundary and map the boundary
   * result to a scorecard entry (or an error Result for infrastructure failures).
   * Shared by the orderbook/perp and swap/dex arms — each builds its own payload;
   * the invoke + result mapping is identical.
   */
  private async scoreViaBoundary(input: {
    payload: unknown;
    presetKey: string;
    presetBehaviorVersion: string;
  }): Promise<Result<PresetScorecardEntry>> {
    if (!this.scoreCandidateBoundary) {
      return err({
        code: 'assessment.scorecard_boundary_unavailable',
        message: 'score_candidate boundary is not configured',
      });
    }

    const result = await this.scoreCandidateBoundary.invoke({
      toolName: 'score_candidate',
      payload: input.payload,
    });

    switch (result.kind) {
      case 'success': {
        const { signal, candlesEvaluated } = parseScoreCandidateData(result.data);
        return ok(
          buildScorecardEntry({
            presetKey: input.presetKey,
            presetBehaviorVersion: input.presetBehaviorVersion,
            hasSignal: signal !== null,
            confidence: signal?.confidence ?? null,
            candlesEvaluated,
          }),
        );
      }
      case 'in_progress':
        // A read should be synchronous; an unexpected in-progress is a transient
        // infrastructure gap, not a scan outcome — propagate as an error.
        return err({
          code: 'assessment.scorecard_boundary_in_progress',
          message: 'score_candidate boundary invocation is still in progress',
        });
      case 'failure':
        return err({
          code: 'assessment.scorecard_failed',
          message: `score_candidate failed (${result.code}): ${result.message}`,
        });
      case 'transport_error':
        return err({
          code: 'assessment.scorecard_boundary_unreachable',
          message: `score_candidate boundary unreachable: ${result.message}`,
        });
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPresetScorecardRunner(
  deps: PresetScorecardRunnerDeps,
): PresetScorecardRunner {
  return new PresetScorecardRunnerImpl(deps);
}

// ── Scorecard assembly ────────────────────────────────────────────────────────

/** Build a scorecard entry from a scored outcome (shared by both branches). */
function buildScorecardEntry(input: {
  presetKey: string;
  presetBehaviorVersion: string;
  hasSignal: boolean;
  confidence: number | null;
  candlesEvaluated: number;
}): PresetScorecardEntry {
  // single-symbol dry-run: exactly one candidate.
  const candidatesDiscovered = 1;
  const candidatesScored = 1;
  const signalsGenerated = input.hasSignal ? 1 : 0;
  const topConfidence = input.hasSignal ? input.confidence : null;

  // NOTE: 'degraded' is unreachable in a single-symbol dry-run (only 1
  // candidate). The domain type includes it for future multi-symbol
  // assessment or aggregate scan metrics.
  let scanHealth: PresetScorecardEntry['scanHealth'];
  if (input.hasSignal) {
    scanHealth = 'healthy';
  } else if (input.candlesEvaluated > 0) {
    scanHealth = 'no_signal';
  } else {
    scanHealth = 'stale';
  }

  return {
    presetKey: input.presetKey,
    presetBehaviorVersion: input.presetBehaviorVersion,
    candidatesDiscovered,
    candidatesScored,
    signalsGenerated,
    topConfidence,
    scanHealth,
    evaluationScope: 'single_symbol_dry_run',
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The subset of the boundary `score_candidate` success payload the runner needs. */
interface ParsedScoreCandidateData {
  signal: { confidence: number | null } | null;
  candlesEvaluated: number;
}

/**
 * Narrow the boundary `score_candidate` success payload (`unknown` over the
 * wire) to the fields the scorecard needs: the signal (with a numeric
 * confidence) or null, and the count of candles evaluated.
 */
function parseScoreCandidateData(data: unknown): ParsedScoreCandidateData {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawSignal = record['signal'];
  const rawCandlesEvaluated = record['candlesEvaluated'];

  const candlesEvaluated =
    typeof rawCandlesEvaluated === 'number' && Number.isFinite(rawCandlesEvaluated)
      ? rawCandlesEvaluated
      : 0;

  if (rawSignal && typeof rawSignal === 'object') {
    const confidence = (rawSignal as Record<string, unknown>)['confidence'];
    return {
      signal: { confidence: typeof confidence === 'number' ? confidence : null },
      candlesEvaluated,
    };
  }

  return { signal: null, candlesEvaluated };
}

/** Resolve a canonical symbol string from the assessment identity. */
function resolveSymbol(identity: MarketAssessmentIdentity): string {
  switch (identity.instrumentKind) {
    case 'orderbook':
    case 'perp':
      return identity.symbol;
    case 'swap':
    case 'dex':
      return `${identity.network}:${identity.address}`;
    default:
      throw new Error(`Unsupported instrumentKind: ${(identity as { instrumentKind: string }).instrumentKind}`);
  }
}

/** Extract IndicatorConfig from a preset entry's strategy params. */
function extractIndicatorConfig(preset: PresetEntry): IndicatorConfig {
  const params = preset.strategy.params as Record<string, unknown>;
  const raw = params['indicators'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as IndicatorConfig;
  }
  return {};
}

/** Extract signal bias from a preset entry's strategy params. Defaults to 'trend-following'. */
function extractSignalBias(preset: PresetEntry): 'trend-following' | 'mean-reverting' {
  const params = preset.strategy.params as Record<string, unknown>;
  const raw = params['signalBias'];
  if (raw === 'mean-reverting') return 'mean-reverting';
  if (raw === 'trend-following') return 'trend-following';
  // Default for undefined or unrecognized values
  return 'trend-following';
}
