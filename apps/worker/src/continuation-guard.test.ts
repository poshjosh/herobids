import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_NUDGE_TEXT,
  buildContinuationCompletionFields,
  decideContinuationNudge,
  decideFinalTextPersistence,
  parseFinishRunArgs,
  recordFinishRun,
  UnresolvedToolFailureTracker,
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
      'You stopped without calling `finish_run`, which is required to end a run. Check whether you are done. If you are, call `finish_run`; with no arguments it records `complete`, or pass a status (`waiting` or `blocked`) and an optional short reason. If you are not, continue working.',
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

describe('parseFinishRunArgs', () => {
  it('returns the status and reason for valid arguments', () => {
    expect(parseFinishRunArgs({ status: 'waiting', reason: 'need the answer' })).toEqual({ status: 'waiting', reason: 'need the answer' });
  });
  it('returns undefined for an unknown status', () => {
    expect(parseFinishRunArgs({ status: 'done', reason: 'x' })).toBeUndefined();
  });
  it('uses the defaults for no arguments', () => {
    expect(parseFinishRunArgs({})).toEqual({ status: 'complete', reason: 'Done' });
  });
  it('uses the default reason for an empty reason', () => {
    expect(parseFinishRunArgs({ status: 'complete', reason: '' })).toEqual({ status: 'complete', reason: 'Done' });
  });
});

describe('recordFinishRun', () => {
  const args = { status: 'complete', reason: 'all done' };
  it('records a successful call made with no arguments as complete / Done', () => {
    const result = JSON.stringify({ ok: true, status: 'complete', note: 'run end recorded' });
    expect(recordFinishRun(result, {})).toEqual({ status: 'complete', reason: 'Done' });
  });
  it('records a successful call', () => {
    const result = JSON.stringify({ ok: true, status: 'complete', note: 'run end recorded' });
    expect(recordFinishRun(result, args)).toEqual({ status: 'complete', reason: 'all done' });
  });
  it('records nothing for a rejection with valid args (tool not in the skill set)', () => {
    const result = JSON.stringify({ ok: false, error: 'tool rejected: finish_run is not available in the current skill set', retryable: false, fault: false });
    expect(recordFinishRun(result, args)).toBeUndefined();
  });
  it('records nothing for a validation error', () => {
    const result = JSON.stringify({ ok: false, error: 'bad', errorCode: 'validation.invalid_parameters', retryable: false, fault: false });
    expect(recordFinishRun(result, { status: 'complete' })).toBeUndefined();
  });
  it('records nothing for a fault failure', () => {
    expect(recordFinishRun(JSON.stringify({ ok: false, error: 'x', fault: true }), args)).toBeUndefined();
  });
  it('records nothing when ok is true but the args do not fit the schema', () => {
    expect(recordFinishRun(JSON.stringify({ ok: true }), { status: 'nope', reason: 'x' })).toBeUndefined();
  });
  it('records nothing for a result that is not JSON', () => {
    expect(recordFinishRun('not json', args)).toBeUndefined();
  });
});

describe('buildContinuationCompletionFields', () => {
  it('adds nothing when the tool is not visible and no nudge was sent', () => {
    expect(buildContinuationCompletionFields({ toolVisible: false, nudgesUsed: 0, finishRun: undefined })).toEqual({});
  });
  it('reports a zero nudge count when the tool is visible', () => {
    expect(buildContinuationCompletionFields({ toolVisible: true, nudgesUsed: 0, finishRun: undefined })).toEqual({ nudgeCount: 0 });
  });
  it('reports nudges sent even when the tool is no longer visible', () => {
    expect(buildContinuationCompletionFields({ toolVisible: false, nudgesUsed: 1, finishRun: undefined })).toEqual({ nudgeCount: 1 });
  });
  it('reports the finish_run status and reason when recorded', () => {
    expect(buildContinuationCompletionFields({ toolVisible: true, nudgesUsed: 2, finishRun: { status: 'blocked', reason: 'no access' } }))
      .toEqual({ nudgeCount: 2, finishRunStatus: 'blocked', finishRunReason: 'no access' });
  });
  it('reports the length recoveries of the run when there were any', () => {
    expect(buildContinuationCompletionFields({ toolVisible: false, nudgesUsed: 0, finishRun: undefined, lengthRecoveries: 2 }))
      .toEqual({ lengthRecoveries: 2 });
  });
  it('omits the length recoveries when there were none', () => {
    expect(buildContinuationCompletionFields({ toolVisible: true, nudgesUsed: 0, finishRun: undefined, lengthRecoveries: 0 }))
      .toEqual({ nudgeCount: 0 });
  });
});

describe('decideFinalTextPersistence', () => {
  it('skips a nudged turn', () => {
    expect(decideFinalTextPersistence({ continues: true, toolCallNames: [], assistantResponse: 'all done' })).toBeUndefined();
  });
  it('stores the text of an un-nudged turn without tool calls right away', () => {
    expect(decideFinalTextPersistence({ continues: false, toolCallNames: [], assistantResponse: 'closing' }))
      .toEqual({ when: 'now', text: 'closing' });
  });
  it('keeps only the finish_run turn\'s own text, to be stored if that turn ends the run', () => {
    expect(decideFinalTextPersistence({ continues: false, toolCallNames: ['send_message', 'finish_run'], assistantResponse: 'final words' }))
      .toEqual({ when: 'if_terminal', text: 'final words' });
  });
  it('stores nothing for a bare finish_run turn', () => {
    expect(decideFinalTextPersistence({ continues: false, toolCallNames: ['finish_run'], assistantResponse: '  ' })).toBeUndefined();
  });
  it('stores nothing for a turn with other tool calls', () => {
    expect(decideFinalTextPersistence({ continues: false, toolCallNames: ['set_memory'], assistantResponse: 'working' })).toBeUndefined();
  });
});

describe('UnresolvedToolFailureTracker', () => {
  const fail = JSON.stringify({ ok: false, error: 'invalid parameters: key: Required', fault: false });
  const pass = JSON.stringify({ ok: true });

  it('reports nothing when every call succeeded', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', { key: 'a' }, pass);
    expect(tracker.summary()).toEqual({});
  });
  it('reports a failure that has no later success, even when it is a fault:false validation error', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', {}, fail);
    tracker.record('set_memory', { key: 'index' }, pass);
    expect(tracker.summary()).toEqual({ unresolvedToolFailureCount: 1, unresolvedToolFailures: ['set_memory'] });
  });
  it('drops a failure when the same tool later succeeds on the same target', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', { key: 'index' }, fail);
    tracker.record('set_memory', { key: 'index' }, pass);
    expect(tracker.summary()).toEqual({});
  });
  it('keeps a failure when a different tool or target succeeds', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', { key: 'index' }, fail);
    tracker.record('set_memory', { key: 'other' }, pass);
    tracker.record('get_memory', { key: 'index' }, pass);
    expect(tracker.summary().unresolvedToolFailureCount).toBe(1);
  });
  it('counts every open failure and lists each tool name once', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', { key: 'a' }, fail);
    tracker.record('set_memory', { key: 'b' }, fail);
    tracker.record('browse_url', { url: 'https://x.test' }, fail);
    expect(tracker.summary()).toEqual({ unresolvedToolFailureCount: 3, unresolvedToolFailures: ['browse_url', 'set_memory'] });
  });
  it('ignores empty and unparseable results', () => {
    const tracker = new UnresolvedToolFailureTracker();
    tracker.record('set_memory', {}, null);
    tracker.record('set_memory', {}, 'not json');
    expect(tracker.summary()).toEqual({});
  });
});
