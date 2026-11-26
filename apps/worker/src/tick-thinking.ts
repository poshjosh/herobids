import type { ReasoningLevel } from '@herobids/domain';
import { lowerReasoningLevel } from '@herobids/llm';
import { isUserMessageType } from './tick-gate-state.js';

/**
 * How much reasoning a run deserves (D20): an important run uses the user's level, a lighter run one step below it,
 * a routine run none.
 */
export type RunImportance = 'important' | 'lighter' | 'routine';

export type RunImportanceReason =
  | 'regime_flip'
  | 'drawdown_threshold'
  | 'protection_gap'
  | 'user_message'
  | 'market_wake'
  | 'work_wake'
  | 'first_run'
  | 'agent_message'
  | 'open_positions'
  | 'routine_tick';

export interface TickRunInput {
  hasOpenPositions: boolean;
  regimePass?: boolean | null;
  previousRegimePass?: boolean | null;
  /** A message from the owner (not a peer or child agent). */
  userMessageReceived?: boolean;
  /** A reminder or continuation wake that carries work. */
  workWakeReceived?: boolean;
  /** A market wake (watch, scanner or other trading trigger) started this run. */
  marketWakeReceived?: boolean;
  /** A triggered protective watch, or an open position without protection or coverage. */
  protectionGap?: boolean;
  /** The session's first run, or a resumed run that must re-evaluate in full. */
  firstRun?: boolean;
  /** A peer message or a child agent's report. */
  agentMessageReceived?: boolean;
  drawdownPct?: number | null;
  /** Drawdown percentage that makes the run important. Must be <= 0. */
  drawdownThresholdPct: number;
}

export interface TickRunClassification {
  importance: RunImportance;
  reason: RunImportanceReason;
}

export function classifyTickRun(input: TickRunInput): TickRunClassification {
  const regimeFlipped = input.previousRegimePass !== null
    && input.previousRegimePass !== undefined
    && input.regimePass !== null
    && input.regimePass !== undefined
    && input.previousRegimePass !== input.regimePass;

  if (regimeFlipped) return { importance: 'important', reason: 'regime_flip' };
  if ((input.drawdownPct ?? 0) <= input.drawdownThresholdPct) return { importance: 'important', reason: 'drawdown_threshold' };
  if (input.protectionGap) return { importance: 'important', reason: 'protection_gap' };
  if (input.userMessageReceived) return { importance: 'important', reason: 'user_message' };
  if (input.marketWakeReceived) return { importance: 'important', reason: 'market_wake' };
  if (input.workWakeReceived) return { importance: 'important', reason: 'work_wake' };
  if (input.firstRun) return { importance: 'important', reason: 'first_run' };
  if (input.agentMessageReceived) return { importance: 'important', reason: 'agent_message' };
  if (input.hasOpenPositions) return { importance: 'lighter', reason: 'open_positions' };
  return { importance: 'routine', reason: 'routine_tick' };
}

/**
 * Who sent this tick's user messages. Peer messages, child reports and a creator's message to its child arrive as user
 * messages sent by an agent. A user message flagged by the wake poll but not read this tick counts as the owner's,
 * because the poll cannot tell the sender: a pending peer message not yet read also counts as `user_message`.
 */
export function classifyIncomingUserMessages(
  incomingMessages: ReadonlyArray<Record<string, unknown>>,
  hasPendingUserMessage: boolean,
): { userMessageReceived: boolean; agentMessageReceived: boolean } {
  const userMessages = incomingMessages.filter((message) => isUserMessageType(message['type']));
  return {
    userMessageReceived: userMessages.some((message) => message['initiatorType'] !== 'agent')
      || (hasPendingUserMessage && userMessages.length === 0),
    agentMessageReceived: userMessages.some((message) => message['initiatorType'] === 'agent'),
  };
}

/** This tick's facts, as gathered by the runtime, mapped to the run classifier's input. */
export function buildTickRunInput(params: {
  hasOpenPositions: boolean;
  previousRegimePass: boolean | null;
  regimePass: boolean | null;
  incomingMessages: ReadonlyArray<Record<string, unknown>>;
  hasPendingUserMessage: boolean;
  /** Who scheduled the reminder that woke this tick, snapshotted before the context build clears it. */
  reminderScheduledBy: string | null;
  /** From hasMarketWake, snapshotted before any routing consumes the wake. */
  marketWakeReceived: boolean;
  /** No earlier tick of this session reached the scout or judge (gates can skip the first ticks). */
  firstModelRun: boolean;
  isResumedFullEvaluation: boolean;
  hasTriggeredWatch: boolean;
  hasUncoveredPosition: boolean;
  hasUnprotectedPosition: boolean;
  drawdownPct: number | null;
  drawdownThresholdPct: number;
}): TickRunInput {
  return {
    hasOpenPositions: params.hasOpenPositions,
    previousRegimePass: params.previousRegimePass,
    regimePass: params.regimePass,
    ...classifyIncomingUserMessages(params.incomingMessages, params.hasPendingUserMessage),
    // A reminder wake carries work the agent scheduled for itself.
    workWakeReceived: params.reminderScheduledBy !== null,
    marketWakeReceived: params.marketWakeReceived,
    protectionGap: params.hasTriggeredWatch || params.hasUncoveredPosition || params.hasUnprotectedPosition,
    firstRun: params.firstModelRun || params.isResumedFullEvaluation,
    drawdownPct: params.drawdownPct,
    drawdownThresholdPct: params.drawdownThresholdPct,
  };
}

/**
 * Whether a market wake (watch, scanner or other trading trigger) started this tick. Read it once the scanner-gated
 * suppression has run and before review routing or the context build consume the wake, so a scanner review wake counts.
 */
export function hasMarketWake(metrics: { currentMarketWake: unknown }): boolean {
  return metrics.currentMarketWake !== null && metrics.currentMarketWake !== undefined;
}

/** A premium judge model treats every run as important; the user's level still caps it (resolveRunReasoning). */
export function resolveJudgeRunClassification(
  shared: TickRunClassification,
  premiumJudge: boolean,
): { importance: RunImportance; reason: string } {
  return premiumJudge ? { importance: 'important', reason: 'cost_profile_premium' } : shared;
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

/** The reasoning level a call runs at, why, and the user's choice it was derived from (D23). */
export interface RunReasoning {
  level: ReasoningLevel;
  /** The run's importance reason, or `adaptive_off` when the user's level is used exactly. */
  reason: string;
  /** The user's level: the maximum with adaptive on, the exact level with it off. */
  ceiling: ReasoningLevel;
  adaptive: boolean;
}

/**
 * The user's reasoning level is a promise (D20): the result is never above it. With adaptive on it is a maximum: an
 * important run uses it, a lighter run one step below it, a routine run none. With adaptive off it is used exactly.
 * One mapping for the scout and the judge.
 */
export function resolveRunReasoning(
  run: { importance: RunImportance; reason: string },
  userLevel: ReasoningLevel,
  adaptive: boolean,
): RunReasoning {
  if (!adaptive) {
    return { level: userLevel, reason: 'adaptive_off', ceiling: userLevel, adaptive };
  }
  const level = run.importance === 'important'
    ? userLevel
    : run.importance === 'lighter'
      ? lowerReasoningLevel(userLevel)
      : 'none';
  return { level, reason: run.reason, ceiling: userLevel, adaptive };
}

/**
 * The reasoning fields of an `agent.llm.completed` event (D23). `reasoningSent` is the reasoning the provider was
 * last sent (LlmResponse.reasoningSent), so a provider fallback shows next to the level the run chose.
 */
export function toReasoningEventFields(reasoning: RunReasoning, reasoningSent?: string): {
  reasoningLevel: ReasoningLevel;
  reasoningReason: string;
  reasoningCeiling: ReasoningLevel;
  adaptiveReasoning: boolean;
  reasoningSent?: string;
} {
  return {
    reasoningLevel: reasoning.level,
    reasoningReason: reasoning.reason,
    reasoningCeiling: reasoning.ceiling,
    adaptiveReasoning: reasoning.adaptive,
    ...(reasoningSent !== undefined ? { reasoningSent } : {}),
  };
}
