// TODO(009): Wire PresetScorecardRunner into PlatformAssessor.generateScorecards()

import type { PriceCandle } from '@herobids/market-data';
import type {
  MarketAssessmentIdentity,
  PresetScorecardEntry,
  PresetEntry,
  TradertonReadResult,
} from '@herobids/domain';
import { computePresetBehaviorVersion, err, ok, type Result } from '@herobids/domain';
import { scoreCandidate } from '@herobids/strategy';
import type {
  CandidateContext,
  IndicatorConfig,
  ScanConfig,
} from '@herobids/strategy';

// ── Deps ────────────────────────────────────────────────────────────────────

/**
 * The narrow `score_candidate` read-boundary port the runner consumes for
 * orderbook/perp scoring (L3 Q2 re-point). Structurally identical to the read
 * tools' `ctx.tradertonBoundary`; the composition root binds a SYSTEM subject +
 * deadline. When absent, orderbook scoring cannot proceed (the caller supplies
 * it; the assessor threads one from the worker composition root).
 */
export interface ScoreCandidateBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

export interface PresetScorecardRunnerDeps {
  /**
   * The `score_candidate` boundary for orderbook/perp scoring. Swap/dex scoring
   * stays in-process (see the swap carve-out in generateScorecards). Optional so
   * unit tests can drive the swap path (in-process) without a boundary stub.
   */
  scoreCandidateBoundary?: ScoreCandidateBoundary;
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface PresetScorecardRunner {
  /**
   * Generate deterministic scorecards for all presets in a style tier.
   *
   * Orderbook/perp presets are scored over the Traderton `score_candidate`
   * boundary (candles fetched behind the boundary). Swap/dex presets are scored
   * in-process from the pre-fetched `candles` (the swap re-point is DEFERRED —
   * the boundary needs a pool address the identity does not carry). Returns an
   * error Result when the boundary reports an infrastructure failure so the
   * caller can propagate it (never synthesizing a fake scan-health).
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
    const { identity, presets, candles } = params;
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

      let entryResult: Result<PresetScorecardEntry>;
      if (isOrderbookLike) {
        // Re-point orderbook/perp scoring to the boundary `score_candidate` tool.
        // The boundary fetches candles itself from the identifiers; providerSymbol
        // = identity.symbol reproduces the old in-process behaviour by construction
        // (the old path passed identity.symbol as the candidate symbol).
        entryResult = await this.scoreOrderbookViaBoundary({
          identity,
          symbol,
          presetKey,
          presetBehaviorVersion,
          scanConfig,
        });
      } else {
        // Swap/dex carve-out: the boundary re-point is DEFERRED (score_candidate
        // needs a pool address the identity lacks). Keep the existing in-process
        // scoreCandidate path for swap ONLY so we do not degrade swap parity.
        entryResult = ok(
          scoreSwapInProcess({
            symbol,
            candles,
            venueFamily: identity.venueFamily,
            presetKey,
            presetBehaviorVersion,
            scanConfig,
          }),
        );
      }

      if (!entryResult.ok) {
        return entryResult;
      }
      output.push(entryResult.data);
    }

    return ok(output);
  }

  /** Score an orderbook/perp candidate over the `score_candidate` boundary. */
  private async scoreOrderbookViaBoundary(input: {
    identity: MarketAssessmentIdentity;
    symbol: string;
    presetKey: string;
    presetBehaviorVersion: string;
    scanConfig: ScanConfig;
  }): Promise<Result<PresetScorecardEntry>> {
    if (!this.scoreCandidateBoundary) {
      return err({
        code: 'assessment.scorecard_boundary_unavailable',
        message: 'score_candidate boundary is not configured',
      });
    }

    const payload = {
      symbol: input.symbol,
      instrumentId: input.symbol,
      venueType: 'orderbook' as const,
      providerSymbol: input.symbol,
      venue: input.identity.venueFamily,
      config: input.scanConfig,
    };

    const result = await this.scoreCandidateBoundary.invoke({
      toolName: 'score_candidate',
      payload,
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

/** Score a swap/dex candidate in-process from pre-fetched candles (deferred re-point). */
function scoreSwapInProcess(input: {
  symbol: string;
  candles: PriceCandle[];
  venueFamily: string;
  presetKey: string;
  presetBehaviorVersion: string;
  scanConfig: ScanConfig;
}): PresetScorecardEntry {
  const candidate: CandidateContext = {
    symbol: input.symbol,
    instrumentId: input.symbol,
    candles: input.candles,
    venue: input.venueFamily,
    // Swap identities carried venueType undefined in the source in-process path.
    venueType: undefined,
  };

  const signal = scoreCandidate(candidate, input.scanConfig);

  return buildScorecardEntry({
    presetKey: input.presetKey,
    presetBehaviorVersion: input.presetBehaviorVersion,
    hasSignal: signal !== null,
    confidence: signal?.confidence ?? null,
    candlesEvaluated: input.candles.length,
  });
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
