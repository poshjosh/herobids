// TODO(009): Wire PresetScorecardRunner into PlatformAssessor.generateScorecards()

import type { PriceCandle } from '@herobids/market-data';
import type {
  MarketAssessmentIdentity,
  PresetScorecardEntry,
  PresetEntry,
} from '@herobids/domain';
import { computePresetBehaviorVersion } from '@herobids/domain';
import { scoreCandidate } from '@herobids/strategy';
import type {
  CandidateContext,
  IndicatorConfig,
  ScanConfig,
} from '@herobids/strategy';

// ── Deps ────────────────────────────────────────────────────────────────────

// NOTE: getCandles was intentionally removed — candles are pre-fetched by the
// caller (the assessor). If future presets need different lookback windows
// than the shared candles provide, re-add getCandles here.
export interface PresetScorecardRunnerDeps {
  // reserved for future preset-specific candle windows
}

// ── Interface ───────────────────────────────────────────────────────────────

export interface PresetScorecardRunner {
  /** Generate deterministic scorecards for all presets in a style tier. */
  generateScorecards(params: {
    identity: MarketAssessmentIdentity;
    presets: Array<{ key: string; entry: PresetEntry }>;
    candles: PriceCandle[];
  }): PresetScorecardEntry[];
}

// ── Implementation ──────────────────────────────────────────────────────────

export class PresetScorecardRunnerImpl implements PresetScorecardRunner {
  constructor(private readonly _deps: PresetScorecardRunnerDeps) {}

  generateScorecards(params: {
    identity: MarketAssessmentIdentity;
    presets: Array<{ key: string; entry: PresetEntry }>;
    candles: PriceCandle[];
  }): PresetScorecardEntry[] {
    const { identity, presets, candles } = params;
    const symbol = resolveSymbol(identity);
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

      const candidate: CandidateContext = {
        symbol,
        instrumentId: symbol,
        candles,
        venue: identity.venueFamily,
        venueType: identity.instrumentKind === 'orderbook' || identity.instrumentKind === 'perp'
          ? 'orderbook'
          : undefined,
      };

      const signal = scoreCandidate(candidate, scanConfig);

      // single-symbol dry-run: exactly one candidate
      const candidatesDiscovered = 1;
      const candidatesScored = 1;
      const signalsGenerated = signal ? 1 : 0;
      const topConfidence = signal?.confidence ?? null;

      // NOTE: 'degraded' is unreachable in a single-symbol dry-run (only 1
      // candidate). The domain type includes it for future multi-symbol
      // assessment or aggregate scan metrics.
      let scanHealth: PresetScorecardEntry['scanHealth'];
      if (signal) {
        scanHealth = 'healthy';
      } else if (candles.length > 0) {
        scanHealth = 'no_signal';
      } else {
        scanHealth = 'stale';
      }

      output.push({
        presetKey,
        presetBehaviorVersion,
        candidatesDiscovered,
        candidatesScored,
        signalsGenerated,
        topConfidence,
        scanHealth,
        evaluationScope: 'single_symbol_dry_run',
      });
    }

    return output;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createPresetScorecardRunner(
  deps: PresetScorecardRunnerDeps,
): PresetScorecardRunner {
  return new PresetScorecardRunnerImpl(deps);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a canonical symbol string from the assessment identity. */
function resolveSymbol(identity: MarketAssessmentIdentity): string {
  switch (identity.instrumentKind) {
    case 'orderbook':
    case 'perp':
      return identity.symbol;
    case 'swap':
    case 'dex':
      return `${identity.network}:${identity.address}`;
    default: {
      const _exhaustive: never = identity;
      throw new Error(`Unsupported instrumentKind: ${(identity as MarketAssessmentIdentity).instrumentKind}`);
    }
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
