import { FINISH_RUN_STATUSES } from '@herobids/domain';
import { FinishRunParamsSchema } from './tools/finish-run.js';

/**
 * Nudge sent when a model stops without calling `finish_run`.
 * It states the rule and asks the agent to check its own definition of done.
 * It makes no claim about time or budget: the platform does not know either.
 */
export const CONTINUATION_NUDGE_TEXT =
  'You stopped without calling `finish_run`, which is required to end a run. ' +
  'Check whether you are done. ' +
  'If you are, call `finish_run` with a status (`complete`, `waiting` or `blocked`) and a short reason. ' +
  'If you are not, continue working.';

export interface ContinuationNudgeInput {
  /** True when `finish_run` is currently visible to the agent (decided by its skills). */
  toolVisible: boolean;
  /** True once a `finish_run` call has succeeded in this run. */
  finishRunCalled: boolean;
  nudgesUsed: number;
  maxNudges: number;
  /** Zero-based index of the turn that just ended without tool calls. */
  turnIndex: number;
  maxTurns: number;
}

/**
 * Returns the nudge text when the run should continue instead of ending, else undefined.
 * Never nudges on the last allowed turn: the loop would then end as a turn-limit stop.
 */
export function decideContinuationNudge(input: ContinuationNudgeInput): string | undefined {
  if (!input.toolVisible || input.finishRunCalled) {
    return undefined;
  }
  if (input.nudgesUsed >= input.maxNudges) {
    return undefined;
  }
  if (input.turnIndex >= input.maxTurns - 1) {
    return undefined;
  }
  return CONTINUATION_NUDGE_TEXT;
}

export interface FinishRunRecord {
  status: (typeof FINISH_RUN_STATUSES)[number];
  reason: string;
}

/**
 * Reads a `finish_run` call's arguments. Use `recordFinishRun` to also check the call's result.
 * Returns undefined when the arguments do not fit the tool's schema, so nothing is recorded.
 */
export function parseFinishRunArgs(args: Record<string, unknown>): FinishRunRecord | undefined {
  const parsed = FinishRunParamsSchema.safeParse(args);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Records a `finish_run` call only when its serialized result says `ok: true`.
 * Rejections (`ok: false`, even with `fault: false`, e.g. tool not in the skill set) and
 * unparseable results record nothing.
 */
export function recordFinishRun(toolResult: string, args: Record<string, unknown>): FinishRunRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResult);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
    return undefined;
  }
  return parseFinishRunArgs(args);
}

export interface ContinuationCompletionInput {
  toolVisible: boolean;
  nudgesUsed: number;
  finishRun: FinishRunRecord | undefined;
}

/**
 * Optional fields for the judge `agent.llm.completed` event.
 * `finishRun.status` says why the agent stopped. It is not the replied/no_reply outcome of the tick.
 */
export function buildContinuationCompletionFields(input: ContinuationCompletionInput): {
  nudgeCount?: number;
  finishRunStatus?: FinishRunRecord['status'];
  finishRunReason?: string;
} {
  return {
    ...(input.toolVisible || input.nudgesUsed > 0 ? { nudgeCount: input.nudgesUsed } : {}),
    ...(input.finishRun ? { finishRunStatus: input.finishRun.status, finishRunReason: input.finishRun.reason } : {}),
  };
}
export interface FinalTextTurnInput {
  /** True when a nudge follows this turn, so it is not the end of the run. */
  continues: boolean;
  toolCallNames: readonly string[];
  assistantResponse: string;
}
export type FinalTextPersistence =
  /** Store now: a closing reply with no tool calls. */
  | { when: 'now'; text: string }
  /** Store after the loop, and only if the run ended because of this turn's `finish_run`. */
  | { when: 'if_terminal'; text: string };
/**
 * Decides whether a judge turn's text is the run's closing text.
 * A nudged turn is never stored. A `finish_run` turn stores only its own text (a bare call stores nothing),
 * never an earlier turn's text.
 */
export function decideFinalTextPersistence(input: FinalTextTurnInput): FinalTextPersistence | undefined {
  if (input.continues) {
    return undefined;
  }
  if (input.toolCallNames.length === 0) {
    return { when: 'now', text: input.assistantResponse };
  }
  if (input.toolCallNames.includes('finish_run') && input.assistantResponse.trim() !== '') {
    return { when: 'if_terminal', text: input.assistantResponse };
  }
  return undefined;
}
