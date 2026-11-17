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
