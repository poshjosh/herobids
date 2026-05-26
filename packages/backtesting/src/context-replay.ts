import type { Strategy, MarketSnapshot, Decision } from '@herobids/domain';
import type { Price } from '@herobids/domain';

/**
 * A stored decision context that can be replayed through a strategy.
 */
export interface StoredDecisionContext {
  /** Original decision ID */
  decisionId: string;
  /** Context hash at decision time */
  contextHash: string;
  /** Normalized context payload */
  context: {
    symbol: string;
    price: string;
    timestamp: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** Original decision intent */
  originalIntent: string | null;
  /** Original target size */
  originalTargetSize: string | null;
}

/**
 * Result of replaying a single context through a strategy.
 */
export interface ContextReplayResult {
  /** Original decision ID */
  decisionId: string;
  /** Context hash */
  contextHash: string;
  /** Whether the replay produced the same intent */
  intentMatch: boolean;
  /** Whether the replay produced the same target size */
  sizeMatch: boolean;
  /** Original intent */
  originalIntent: string | null;
  /** Replayed intent */
  replayedIntent: string | null;
  /** Original target size */
  originalTargetSize: string | null;
  /** Replayed target size */
  replayedTargetSize: string | null;
  /** Whether the replay call errored */
  error: string | null;
}

/**
 * Summary of a context replay batch.
 */
export interface ContextReplaySummary {
  /** Total contexts replayed */
  total: number;
  /** Number with matching intent */
  intentMatches: number;
  /** Number with matching target size */
  sizeMatches: number;
  /** Number that errored */
  errors: number;
  /** Intent match percentage */
  intentMatchPct: number;
  /** Size match percentage */
  sizeMatchPct: number;
  /** Individual results (only divergent or errored) */
  divergences: ContextReplayResult[];
}

/**
 * Replay a batch of stored decision contexts through a strategy.
 * Useful for regression testing: does a new model/prompt produce the same decisions
 * as when those contexts were originally evaluated?
 *
 * @param strategy The strategy to replay through
 * @param contexts Stored decision contexts from previous runs
 * @param strategyConfig Config to pass to strategy.evaluate()
 * @param priceFactory Factory to convert string prices to Price type
 */
export async function replayContexts(
  strategy: Strategy,
  contexts: StoredDecisionContext[],
  strategyConfig: Record<string, unknown>,
  priceFactory: (value: string) => Price,
): Promise<ContextReplaySummary> {
  const results: ContextReplayResult[] = [];
  let intentMatches = 0;
  let sizeMatches = 0;
  let errors = 0;

  for (const ctx of contexts) {
    const snapshot: MarketSnapshot = {
      symbol: ctx.context.symbol,
      price: priceFactory(ctx.context.price),
      timestamp: ctx.context.timestamp,
      data: ctx.context.data,
    };

    let replayedIntent: string | null = null;
    let replayedTargetSize: string | null = null;
    let error: string | null = null;

    const evalResult = await strategy.evaluate(snapshot, strategyConfig);

    if (evalResult.ok) {
      const decision = evalResult.data;
      replayedIntent = decision?.intent ?? null;
      replayedTargetSize = decision?.targetSize?.toString() ?? null;
    } else {
      error = evalResult.error.message;
      errors++;
    }

    // Errors must not count as matches — null replayed values would falsely match null originals
    const intentMatch = error === null && ctx.originalIntent === replayedIntent;
    const sizeMatch = error === null && ctx.originalTargetSize === replayedTargetSize;

    if (intentMatch) intentMatches++;
    if (sizeMatch) sizeMatches++;

    const result: ContextReplayResult = {
      decisionId: ctx.decisionId,
      contextHash: ctx.contextHash,
      intentMatch,
      sizeMatch,
      originalIntent: ctx.originalIntent,
      replayedIntent,
      originalTargetSize: ctx.originalTargetSize,
      replayedTargetSize,
      error,
    };

    results.push(result);
  }

  const total = contexts.length;
  const divergences = results.filter(r => !r.intentMatch || !r.sizeMatch || r.error !== null);

  return {
    total,
    intentMatches,
    sizeMatches,
    errors,
    intentMatchPct: total > 0 ? (intentMatches / total) * 100 : 0,
    sizeMatchPct: total > 0 ? (sizeMatches / total) * 100 : 0,
    divergences,
  };
}
