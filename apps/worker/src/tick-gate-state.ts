import type { InstrumentHashEntry, TickGateState } from './tick-gates.js';
import { computePriceBucket, computePnlBucket } from './tick-gates.js';

export interface BuildTickGateStateParams {
  tickNumber: number;
  incomingMessages: Array<Record<string, unknown>>;
  hasOpenPositions: boolean;
  lastKnownPositionSide?: string | null;
  tradingHours?: TickGateState['tradingHours'];
  now?: Date;
  /** Stable digest of the active watch summary, computed before gate decision.
   * When "__unknown__", the watch state was unavailable. Passed through to
   * TickGateState for use by the context-hash gate. */
  watchSummaryDigest?: string;
  /** Stable digest of the pending wake signal buffer.
   *  `"__none__"` when the buffer is empty.
   *  `undefined` means wake signal state is not incorporated (backward compat). */
  wakeSignalDigest?: string;
  /** Stable digest of risk/playbook data (drawdown bucket + open position count).
   *  `"__unknown__"` when the data is unavailable.
   *  `undefined` means risk state is not incorporated (backward compat). */
  riskPlaybookDigest?: string;
  /** Stable digest of pending market context-only events (no agent.wake).
   *  `"__none__"` when the buffer is empty.
   *  `undefined` means context events are not incorporated (backward compat). */
  marketEventDigest?: string;
  /** True when a wake was drained from the wake-signal buffer (wake group consumed it, runtime group did not). */
  hasBufferedWake?: boolean;
  previousContextHash?: string | null;
  baseTickIntervalMs?: number;
  currentTickIntervalMs?: number;
  enabledGates?: TickGateState['enabledGates'];
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const parsed = Number(match[0]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function parseSnapshotPnl(payloadRecord: Record<string, unknown>): number | null {
  // Only use top-level `pnl` which represents current portfolio/unrealized P&L.
  // Do NOT fall back to position.realizedPnl — that is historical and would
  // pollute the context-hash gate with values unrelated to current exposure.
  return parseNumericValue(payloadRecord['pnl']);
}

/**
 * Aggregate tick signals from ALL context snapshots in the incoming message batch.
 * Multi-instrument agents emit multiple snapshots on reconnect; the tick gate
 * must incorporate all of them rather than stopping at the first one found.
 *
 * For price: use the latest-seen price (last snapshot in chronological order).
 * For PnL: sum per-instrument unrealized PnL across snapshots.
 * For positionSide: if any snapshot has a non-flat position, report that side;
 *   if multiple instruments have positions, prefer the latest-seen non-flat side.
 */
function extractTickSignals(
  incomingMessages: Array<Record<string, unknown>>,
  lastKnownPositionSide?: string | null,
): {
  latestPrice: number | null;
  portfolioPnlUsd: number | null;
  positionSide: string | null;
  instrumentSnapshots: InstrumentHashEntry[];
} {
  let latestPrice: number | null = null;
  let portfolioPnlUsd: number | null = null;
  let positionSide: string | null = lastKnownPositionSide ?? null;
  let foundAnySnapshot = false;

  // Per-instrument state keyed by symbol for stable hashing.
  // Uses a Map to keep the latest data per instrument (last-write-wins per symbol).
  const instrumentMap = new Map<string, { price: number | null; pnl: number | null; side: string }>();

  // Scan forward (oldest → newest) so the last-seen price/side wins
  for (let index = 0; index < incomingMessages.length; index++) {
    const message = incomingMessages[index]!;
    const type = message['type'];
    const payload = message['payload'];
    if (type !== 'instance.context.snapshot' || !payload || typeof payload !== 'object') {
      continue;
    }
    foundAnySnapshot = true;

    const payloadRecord = payload as Record<string, unknown>;
    const snapshotPrice = parseNumericValue(payloadRecord['price']);
    latestPrice = snapshotPrice ?? latestPrice;

    const snapshotPnl = parseSnapshotPnl(payloadRecord);
    if (snapshotPnl !== null) {
      portfolioPnlUsd = (portfolioPnlUsd ?? 0) + snapshotPnl;
    }

    let snapshotSide = 'flat';
    const position = payloadRecord['position'];
    if (position && typeof position === 'object') {
      const rawSide = (position as Record<string, unknown>)['side'];
      if (typeof rawSide === 'string') {
        positionSide = rawSide;
        snapshotSide = rawSide;
      }
    } else if (position === null) {
      // Only mark flat if no other non-flat position has been seen yet;
      // a subsequent snapshot with a position will override back to non-flat.
      if (positionSide === lastKnownPositionSide || positionSide === null) {
        positionSide = 'flat';
      }
    }

    // Track per-instrument state for stable hashing
    const symbol = typeof payloadRecord['symbol'] === 'string' ? payloadRecord['symbol'] : '_default';
    instrumentMap.set(symbol, { price: snapshotPrice, pnl: snapshotPnl, side: snapshotSide });
  }

  if (!foundAnySnapshot) {
    return { latestPrice: null, portfolioPnlUsd: null, positionSide: lastKnownPositionSide ?? null, instrumentSnapshots: [] };
  }

  // Build sorted instrument summaries for order-independent hashing
  const instrumentSnapshots: InstrumentHashEntry[] = [...instrumentMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, data]) => ({
      symbol,
      priceBucket: computePriceBucket(data.price),
      pnlBucket: computePnlBucket(data.pnl),
      side: data.side,
    }));

  return { latestPrice, portfolioPnlUsd, positionSide, instrumentSnapshots };
}

export function buildTickGateState(params: BuildTickGateStateParams): TickGateState {
  const tickSignals = extractTickSignals(params.incomingMessages, params.lastKnownPositionSide);
  // hasWakeSignal gates hybrid LLM dispatch. It is normally derived from the
  // runtime group's incomingMessages, but in the two-consumer-group race the
  // wake group may consume an `agent.wake` before the runtime group sees it.
  // In that case the wake is buffered and drained into currentMarketWake, and
  // runTick passes hasBufferedWake=true so the gate still unblocks.
  // See docs/tech/agents/wake-signal-and-technical-scan.md.
  const hasWakeSignal = params.incomingMessages.some((message) => message['type'] === 'agent.wake')
    || params.hasBufferedWake === true;

  return {
    tickNumber: params.tickNumber,
    hasOpenPositions: params.hasOpenPositions,
    hasWakeSignal,
    tradingHours: params.tradingHours,
    now: params.now,
    positionSide: tickSignals.positionSide ?? (params.hasOpenPositions ? params.lastKnownPositionSide ?? 'open' : 'flat'),
    latestPrice: tickSignals.latestPrice,
    portfolioPnlUsd: tickSignals.portfolioPnlUsd,
    instrumentSnapshots: tickSignals.instrumentSnapshots.length > 0 ? tickSignals.instrumentSnapshots : undefined,
    watchSummaryDigest: params.watchSummaryDigest,
    wakeSignalDigest: params.wakeSignalDigest,
    riskPlaybookDigest: params.riskPlaybookDigest,
    marketEventDigest: params.marketEventDigest,
    previousContextHash: params.previousContextHash,
    baseTickIntervalMs: params.baseTickIntervalMs,
    currentTickIntervalMs: params.currentTickIntervalMs,
    enabledGates: params.enabledGates,
  };
}