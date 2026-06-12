import type { TickGateState } from './tick-gates.js';

export interface BuildTickGateStateParams {
  tickNumber: number;
  incomingMessages: Array<Record<string, unknown>>;
  hasOpenPositions: boolean;
  lastKnownPositionSide?: string | null;
  tradingHours?: TickGateState['tradingHours'];
  now?: Date;
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

function extractTickSignals(
  incomingMessages: Array<Record<string, unknown>>,
  lastKnownPositionSide?: string | null,
): {
  latestPrice: number | null;
  portfolioPnlUsd: number | null;
  positionSide: string | null;
} {
  let latestPrice: number | null = null;
  let portfolioPnlUsd: number | null = null;
  let positionSide: string | null = lastKnownPositionSide ?? null;

  for (let index = incomingMessages.length - 1; index >= 0; index--) {
    const message = incomingMessages[index]!;
    const type = message['type'];
    const payload = message['payload'];
    if (type !== 'instance.context.snapshot' || !payload || typeof payload !== 'object') {
      continue;
    }

    const payloadRecord = payload as Record<string, unknown>;
    latestPrice = parseNumericValue(payloadRecord['price']) ?? latestPrice;
    portfolioPnlUsd = parseNumericValue(payloadRecord['pnl']) ?? portfolioPnlUsd;

    const position = payloadRecord['position'];
    if (position && typeof position === 'object') {
      const rawSide = (position as Record<string, unknown>)['side'];
      positionSide = typeof rawSide === 'string' ? rawSide : positionSide;
    } else if (position === null) {
      positionSide = 'flat';
    }

    break;
  }

  return { latestPrice, portfolioPnlUsd, positionSide };
}

export function buildTickGateState(params: BuildTickGateStateParams): TickGateState {
  const tickSignals = extractTickSignals(params.incomingMessages, params.lastKnownPositionSide);
  const hasWakeSignal = params.incomingMessages.some((message) => message['type'] === 'agent.market.wake');

  return {
    tickNumber: params.tickNumber,
    hasOpenPositions: params.hasOpenPositions,
    hasWakeSignal,
    tradingHours: params.tradingHours,
    now: params.now,
    positionSide: tickSignals.positionSide ?? (params.hasOpenPositions ? params.lastKnownPositionSide ?? 'open' : 'flat'),
    latestPrice: tickSignals.latestPrice,
    portfolioPnlUsd: tickSignals.portfolioPnlUsd,
    previousContextHash: params.previousContextHash,
    baseTickIntervalMs: params.baseTickIntervalMs,
    currentTickIntervalMs: params.currentTickIntervalMs,
    enabledGates: params.enabledGates,
  };
}