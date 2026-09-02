import { describe, expect, it } from 'vitest';
import {
  isEarlyTickTriggerType,
  isUserMessageType,
  extractUserMessageText,
  USER_MESSAGE_TYPE,
  AGENT_USER_MESSAGE_TYPE,
  AGENT_WAKE_TYPE,
} from './tick-gate-state.js';

describe('isEarlyTickTriggerType', () => {
  it('treats an agent.wake as an early-tick trigger', () => {
    expect(isEarlyTickTriggerType(AGENT_WAKE_TYPE)).toBe(true);
  });

  it('treats a user.message as an early-tick trigger', () => {
    expect(isEarlyTickTriggerType(USER_MESSAGE_TYPE)).toBe(true);
  });

  it('treats an agent.user.message as an early-tick trigger', () => {
    expect(isEarlyTickTriggerType(AGENT_USER_MESSAGE_TYPE)).toBe(true);
  });

  it('does not treat routine runtime messages as early-tick triggers', () => {
    expect(isEarlyTickTriggerType('instance.context.snapshot')).toBe(false);
    expect(isEarlyTickTriggerType('agent.runtime.heartbeat')).toBe(false);
    expect(isEarlyTickTriggerType('instance.journal.event')).toBe(false);
  });

  it('is safe for non-string / missing types', () => {
    expect(isEarlyTickTriggerType(undefined)).toBe(false);
    expect(isEarlyTickTriggerType(null)).toBe(false);
    expect(isEarlyTickTriggerType(42)).toBe(false);
  });
});

describe('isUserMessageType', () => {
  it('is true for both user-message channels', () => {
    expect(isUserMessageType(USER_MESSAGE_TYPE)).toBe(true);
    expect(isUserMessageType(AGENT_USER_MESSAGE_TYPE)).toBe(true);
  });

  it('is false for a wake signal (a wake is not a user message)', () => {
    // agent.wake triggers an early tick but is NOT a user message — the
    // pollWakeSignals loop buffers a wake but must not route it through the
    // user-message branch.
    expect(isUserMessageType(AGENT_WAKE_TYPE)).toBe(false);
  });

  it('is false for routine runtime messages and non-strings', () => {
    expect(isUserMessageType('instance.context.snapshot')).toBe(false);
    expect(isUserMessageType(undefined)).toBe(false);
    expect(isUserMessageType(null)).toBe(false);
  });
});

describe('extractUserMessageText', () => {
  it('reads the text from payload.message (the envelope shape produced by the API/Telegram)', () => {
    // Regression guard: reading a top-level `content` field yielded '' here,
    // so the LLM saw an empty user message ([USER] "").
    const envelope = { type: 'user.message', payload: { message: 'What is your name?' } };
    expect(extractUserMessageText(envelope)).toBe('What is your name?');
  });

  it('trims surrounding whitespace', () => {
    expect(extractUserMessageText({ payload: { message: '  hello  ' } })).toBe('hello');
  });

  it('falls back to a top-level content string when payload.message is absent', () => {
    expect(extractUserMessageText({ content: 'legacy text' })).toBe('legacy text');
  });

  it('prefers payload.message over content when both are present', () => {
    expect(extractUserMessageText({ payload: { message: 'from payload' }, content: 'from content' })).toBe('from payload');
  });

  it('returns empty string when neither payload.message nor content is a string', () => {
    expect(extractUserMessageText({ payload: {} })).toBe('');
    expect(extractUserMessageText({ payload: { message: 123 } })).toBe('');
    expect(extractUserMessageText({})).toBe('');
  });
});
