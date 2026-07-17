import type { AgentWakePayload, TechnicalConfig } from '@herobids/domain';
import type { ScoredSignal } from '@herobids/strategy';
import type { TechnicalPhaseResult } from './technical-phase.js';
import type { TechnicalScanState } from './runtime-composition.js';

// ─── Fingerprint helpers ─────────────────────────────────────────────────────

/**
 * Bucket a confidence value into operator-configured bands so small noise
 * (e.g. 0.40 → 0.42) does not trigger a wake.
 */
export function bucketConfidence(value: number, size: number): string {
  return (Math.round(value / size) * size).toFixed(2);
}

/**
 * Build a deterministic fingerprint from the current scanner signal set.
 *
 * Top N signals are canonicalized alphabetically by instrumentId (not rank),
 * confidence is bucketed, and exit advisories are sorted. The resulting string
 * is stable across scans with the same set of signals, regardless of internal
 * ranking churn.
 */
export function computeSignalFingerprint(
  signals: ScoredSignal[],
  exitAdvisorySymbols: string[],
  regimePass: boolean | null,
  topN: number,
  bucketSize: number,
): string {
  const signalParts = signals
    .slice(0, topN)
    .map((signal) => `${signal.instrumentId}:${bucketConfidence(signal.confidence, bucketSize)}`)
    .sort();
  const exitPart =
    exitAdvisorySymbols.length > 0
      ? `exit:${[...exitAdvisorySymbols].sort().join(',')}`
      : 'exit:none';
  const regimePart =
    regimePass === null ? 'regime:unavailable' : regimePass ? 'regime:pass' : 'regime:block';
  return [...signalParts, exitPart, regimePart].join('|');
}

// ─── Public interface ────────────────────────────────────────────────────────

export interface CompleteTechnicalScanParams {
  phaseResult: TechnicalPhaseResult;
  technicalConfig: TechnicalConfig;
  agentId: string;
  isHybridMode: boolean;
  onTechnicalScanComplete?: (agentId: string, scan: TechnicalScanState) => void | Promise<void>;
  emitAgentWake?: (agentId: string, payload: AgentWakePayload) => Promise<void>;
  onJournalEvent?: (event: { type: string; payload?: Record<string, unknown> }) => void;
}

/**
 * Build a TechnicalScanState from a TechnicalPhaseResult, publish the scan event,
 * and emit a scanner wake when signals or exit advisories are present.
 *
 * Extracted from AgentTradingActor.runTechnicalScan() to enable deterministic
 * integration testing without actor infrastructure (no Redis, no venue).
 */
export async function completeTechnicalScan(params: CompleteTechnicalScanParams): Promise<TechnicalScanState> {
  const { phaseResult, technicalConfig, agentId, isHybridMode, onTechnicalScanComplete, emitAgentWake, onJournalEvent } =
    params;

  const scan: TechnicalScanState = {
    timestamp: new Date().toISOString(),
    scanIntervalMs: technicalConfig.scanIntervalMs,
    regimeResult: phaseResult.regimeResult,
    signals: phaseResult.signals,
    positionIndicators: phaseResult.positionIndicators,
    summary: phaseResult.summary,
    symbolOutcomes: phaseResult.symbolOutcomes,
    discovered: phaseResult.candidatesDiscovered,
    symbolsSelected: phaseResult.symbolsSelected,
    eligible: phaseResult.eligibleCount,
    fetched: phaseResult.fetchedCount,
    unsupported: phaseResult.unsupportedCount,
    fetchFailures: phaseResult.fetchFailures,
    signalsGenerated: phaseResult.signalsGenerated,
    overlapSkipped: phaseResult.overlapSkipped,
  };

  // Journal scanner-data unhealthy when there were eligible symbols but no
  // non-empty candles were returned — not a healthy no-signal scan.
  const eligibleCount = phaseResult.eligibleCount;
  const fetchedCount = phaseResult.fetchedCount;
  if (fetchedCount === 0 && eligibleCount > 0 && onJournalEvent) {
    onJournalEvent({
      type: 'scanner.data_unhealthy',
      payload: {
        agentId,
        discovered: scan.discovered,
        symbolsSelected: scan.symbolsSelected,
        eligible: eligibleCount,
        fetched: fetchedCount,
        unsupported: scan.unsupported,
        fetchFailures: scan.fetchFailures,
        timestamp: scan.timestamp,
      },
    });
  }

  // Forward the completed scan before emitting a wake so the agent runtime
  // can ingest fresh scan state before it routes into the hybrid evaluator.
  // NOTE: errors from onTechnicalScanComplete are intentionally NOT swallowed —
  // if forwarding fails, the wake is skipped (the caller's catch block handles logging).
  if (onTechnicalScanComplete) {
    await onTechnicalScanComplete(agentId, scan);
  }

  // If agent has hybrid mode and scanner found signals or exit advisories, emit a wake.
  const hasExitAdvisories = phaseResult.positionIndicators.some((ind) => ind.exitAdvisory === true);
  const shouldWake = (phaseResult.signals.length > 0 || hasExitAdvisories) && isHybridMode && !!emitAgentWake;

  if (shouldWake && emitAgentWake) {
    const topSignal = phaseResult.signals[0];
    const exitAdvisorySymbols = phaseResult.positionIndicators
      .filter((ind) => ind.exitAdvisory === true)
      .map((ind) => ind.symbol);

    await emitAgentWake(agentId, {
      wakeId: crypto.randomUUID(),
      source: 'scanner',
      reason: [
        phaseResult.signals.length > 0 ? `${phaseResult.signals.length} signal(s)` : '',
        exitAdvisorySymbols.length > 0
          ? `${exitAdvisorySymbols.length} exit advisory/ies (${exitAdvisorySymbols.join(', ')})`
          : '',
      ]
        .filter(Boolean)
        .join(', ') || 'Scanner completed',
      priority: hasExitAdvisories ? 'high' : 'normal',
      eventIds: [],
      requestedAt: new Date().toISOString(),
      context: {
        signalCount: phaseResult.signals.length,
        topSymbol: topSignal?.symbol,
        topConfidence: topSignal?.confidence,
        regimePass: phaseResult.regimeResult?.pass ?? null,
      },
    });
  }

  return scan;
}
