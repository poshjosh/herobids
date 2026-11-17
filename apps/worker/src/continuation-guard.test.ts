import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_NUDGE_TEXT,
  decideContinuationNudge,
  type ContinuationNudgeInput,
} from './continuation-guard.js';

const base: ContinuationNudgeInput = {
  toolVisible: true,
  finishRunCalled: false,
  nudgesUsed: 0,
  maxNudges: 2,
  turnIndex: 3,
  maxTurns: 20,
};

describe('CONTINUATION_NUDGE_TEXT', () => {
  it('is exactly the agreed text', () => {
    expect(CONTINUATION_NUDGE_TEXT).toBe(
      'You stopped without calling `finish_run`, which is required to end a run. Check whether you are done. If you are, call `finish_run` with a status (`complete`, `waiting` or `blocked`) and a short reason. If you are not, continue working.',
    );
  });

  it('makes no claim about time or budget', () => {
    expect(CONTINUATION_NUDGE_TEXT).not.toMatch(
      /\b(time|budget|minutes?|seconds?|hours?|clock|deadline|remaining|left|limit)\b/i,
    );
  });
});

describe('decideContinuationNudge', () => {
  it('returns the nudge when the tool is visible, unfinished, under the cap and not on the last turn', () => {
    expect(decideContinuationNudge(base)).toBe(CONTINUATION_NUDGE_TEXT);
  });

  it('does not nudge an agent that cannot see the tool', () => {
    expect(decideContinuationNudge({ ...base, toolVisible: false })).toBeUndefined();
  });

  it('does not nudge after finish_run has been called', () => {
    expect(decideContinuationNudge({ ...base, finishRunCalled: true })).toBeUndefined();
  });

  it('keeps nudging while under the cap', () => {
    expect(decideContinuationNudge({ ...base, nudgesUsed: 1 })).toBe(CONTINUATION_NUDGE_TEXT);
  });

  it('stops nudging once the cap is reached', () => {
    expect(decideContinuationNudge({ ...base, nudgesUsed: 2 })).toBeUndefined();
  });

  it('never nudges when maxNudges is zero', () => {
    expect(decideContinuationNudge({ ...base, maxNudges: 0 })).toBeUndefined();
  });

  it('does not nudge on the last allowed turn', () => {
    expect(decideContinuationNudge({ ...base, turnIndex: 19 })).toBeUndefined();
  });

  it('nudges on the turn before the last allowed turn', () => {
    expect(decideContinuationNudge({ ...base, turnIndex: 18 })).toBe(CONTINUATION_NUDGE_TEXT);
  });

  it('never nudges when only one or two turns are allowed and the first is the last', () => {
    expect(decideContinuationNudge({ ...base, turnIndex: 0, maxTurns: 1 })).toBeUndefined();
    expect(decideContinuationNudge({ ...base, turnIndex: 1, maxTurns: 2 })).toBeUndefined();
  });
});
