import type { ReasoningLevel } from '@herobids/domain';

export type TickThinkingLevel = 'none' | 'light' | 'deep';

export interface TickThinkingInput {
  hasOpenPositions: boolean;
  regimePass?: boolean | null;
  previousRegimePass?: boolean | null;
  incomingMessagesCount: number;
  userMessageReceived?: boolean;
  drawdownPct?: number | null;
  /** Drawdown percentage that triggers deep thinking. Must be <= 0. */
  drawdownThresholdPct: number;
}

export interface TickThinkingDecision {
  thinking: TickThinkingLevel;
  reason: string;
}

export function classifyTickThinking(input: TickThinkingInput): TickThinkingDecision {
  const regimeFlipped = input.previousRegimePass !== null
    && input.previousRegimePass !== undefined
    && input.regimePass !== null
    && input.regimePass !== undefined
    && input.previousRegimePass !== input.regimePass;

  if (regimeFlipped) {
    return { thinking: 'deep', reason: 'regime_flip' };
  }

  if ((input.drawdownPct ?? 0) <= input.drawdownThresholdPct) {
    return { thinking: 'deep', reason: 'drawdown_threshold' };
  }

  if (input.userMessageReceived) {
    return { thinking: 'deep', reason: 'user_message' };
  }

  if (input.incomingMessagesCount > 0) {
    return { thinking: 'deep', reason: 'new_runtime_event' };
  }

  if (input.hasOpenPositions) {
    return { thinking: 'light', reason: 'open_positions' };
  }

  return { thinking: 'none', reason: 'routine_tick' };
}

export function extractDrawdownPct(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const percentMatch = value.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!percentMatch) {
    return null;
  }

  const parsed = Number(percentMatch[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cap the system-determined thinking level with the user's chosen reasoning level.
 * The user's level acts as a maximum — the system can go lower, never higher.
 * Maps TickThinkingLevel (none/light/deep) against ReasoningLevel (none/low/medium/high).
 */
export function applyReasoningCeiling(
  systemLevel: TickThinkingLevel,
  userLevel: ReasoningLevel,
): TickThinkingLevel {
  const order: Record<TickThinkingLevel | ReasoningLevel, number> = {
    none: 0, low: 1, light: 1, medium: 2, high: 3, deep: 3,
  };
  if ((order[systemLevel] ?? 0) <= (order[userLevel] ?? 0)) return systemLevel;
  // Cap at user level — map ReasoningLevel back to TickThinkingLevel
  if (userLevel === 'none') return 'none';
  if (userLevel === 'low') return 'light';
  return 'deep'; // medium and high both cap at deep (our max TickThinkingLevel)
}

export function toReasoningLevel(tickLevel: TickThinkingLevel): ReasoningLevel {
  if (tickLevel === 'light') return 'low';
  if (tickLevel === 'deep') return 'high';
  return 'none';
}
