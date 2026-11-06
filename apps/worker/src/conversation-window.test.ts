import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@herobids/domain';
import {
  isAwaitingEntry,
  truncateHeadTail,
  truncateText,
  sentMessageRefFromToolResult,
  trimConversationWindow,
  userMessageQueuedAt,
  windowEntryFromConversationRow,
  type ConversationWindowEntry,
} from './conversation-window.js';

const AGENT = 'agent-1';
const at = (minute: number) => Date.parse('2026-06-11T06:00:00.000Z') + minute * 60_000;
const user = (n: number, minute: number): ConversationWindowEntry => ({ id: `user-${n}`, kind: 'USER', text: `u${n}`, timestamp: at(minute) });
const agent = (n: number, minute: number): ConversationWindowEntry => ({ id: `agent-${n}`, kind: 'AGENT', text: `a${n}`, timestamp: at(minute) });

describe('isAwaitingEntry', () => {
  it('is true for a USER entry newer than the marker, or any USER entry when there is no marker', () => {
    expect(isAwaitingEntry(user(1, 5), null)).toBe(true);
    expect(isAwaitingEntry(user(1, 5), at(4))).toBe(true);
    expect(isAwaitingEntry(user(1, 5), at(5))).toBe(false);
  });

  it('is never true for an AGENT entry', () => {
    expect(isAwaitingEntry(agent(1, 9), null)).toBe(false);
  });
});

describe('trimConversationWindow', () => {
  it('keeps the window unchanged while it fits', () => {
    const entries = [user(1, 1), agent(1, 2)];
    expect(trimConversationWindow(entries, null, 4)).toEqual({ entries, evicted: false });
  });

  it('drops answered entries oldest first, and keeps awaiting ones', () => {
    const entries = [user(1, 1), agent(1, 2), user(2, 3), agent(2, 4), user(3, 5)];
    const trimmed = trimConversationWindow(entries, at(4), 3);

    expect(trimmed.evicted).toBe(true);
    expect(trimmed.entries.map((e) => e.id)).toEqual(['user-2', 'agent-2', 'user-3']);
  });

  it('never drops an awaiting message to meet maxMessages, until the hard cap of three times maxMessages', () => {
    const awaiting = [1, 2, 3, 4, 5].map((n) => user(n, n));
    const withinCap = trimConversationWindow(awaiting, null, 2);
    expect(withinCap.entries.map((e) => e.id)).toEqual(['user-1', 'user-2', 'user-3', 'user-4', 'user-5'].slice(0, 5));
    expect(withinCap.evicted).toBe(false);

    const overCap = trimConversationWindow([...awaiting, user(6, 6), user(7, 7)], null, 2);
    expect(overCap.entries.map((e) => e.id)).toEqual(['user-2', 'user-3', 'user-4', 'user-5', 'user-6', 'user-7']);
    expect(overCap.evicted).toBe(true);
  });
});

describe('windowEntryFromConversationRow', () => {
  const row = (overrides: Partial<ConversationMessage>): Pick<ConversationMessage, 'id' | 'senderType' | 'senderId' | 'body' | 'createdAt' | 'queuedAt' | 'deliveryStatus'> => ({
    id: 'a3f9c1d2-0000-4000-8000-000000000001',
    senderType: 'user',
    senderId: 'u1',
    body: 'hello',
    createdAt: new Date(at(1)),
    queuedAt: new Date(at(1)),
    deliveryStatus: 'sent',
    ...overrides,
  });

  it('maps a user row to a USER entry timed by queuedAt', () => {
    expect(windowEntryFromConversationRow(row({}), AGENT)).toEqual({ id: 'a3f9c1d2-0000-4000-8000-000000000001', kind: 'USER', text: 'hello', timestamp: at(1) });
  });

  it('times a retried user message by its bumped queuedAt, so it reads as awaiting after a newer reply', () => {
    const retried = row({ createdAt: new Date(at(1)), queuedAt: new Date(at(30)) });

    expect(windowEntryFromConversationRow(retried, AGENT)?.timestamp).toBe(at(30));
  });

  it('keeps an agent row timed by its createdAt', () => {
    expect(windowEntryFromConversationRow(row({ senderType: 'agent', senderId: AGENT, createdAt: new Date(at(2)), queuedAt: new Date(at(9)) }), AGENT)?.timestamp).toBe(at(2));
  });

  it('maps the agent\'s own sent row to an AGENT entry', () => {
    expect(windowEntryFromConversationRow(row({ senderType: 'agent', senderId: AGENT }), AGENT)?.kind).toBe('AGENT');
  });

  it('maps a creator agent\'s row to a USER entry, as the live capture does', () => {
    expect(windowEntryFromConversationRow(row({ senderType: 'agent', senderId: 'creator-1' }), AGENT)?.kind).toBe('USER');
  });

  it('skips rows that never reached their recipient: failed user messages too', () => {
    expect(windowEntryFromConversationRow(row({ deliveryStatus: 'failed' }), AGENT)).toBeNull();
  });

  it('skips platform rows and the agent\'s failed or refused rows', () => {
    expect(windowEntryFromConversationRow(row({ senderType: 'platform', senderId: null }), AGENT)).toBeNull();
    expect(windowEntryFromConversationRow(row({ senderType: 'agent', senderId: AGENT, deliveryStatus: 'failed' }), AGENT)).toBeNull();
    expect(windowEntryFromConversationRow(row({ senderType: 'agent', senderId: AGENT, deliveryStatus: 'refused' }), AGENT)).toBeNull();
  });
});

describe('userMessageQueuedAt', () => {
  it('reads the envelope queuedAt in ms', () => {
    expect(userMessageQueuedAt({ queuedAt: '2026-06-11T06:45:00.000Z' })).toBe(Date.parse('2026-06-11T06:45:00.000Z'));
  });

  it('is null when the envelope has no valid queuedAt', () => {
    expect(userMessageQueuedAt({})).toBeNull();
    expect(userMessageQueuedAt({ queuedAt: 'not a date' })).toBeNull();
    expect(userMessageQueuedAt({ queuedAt: 5 })).toBeNull();
  });
});

describe('sentMessageRefFromToolResult', () => {
  it('reads the short ref from a successful send_message result', () => {
    expect(sentMessageRefFromToolResult('{"ok":true,"messageId":"a3f9c1d2","note":"message queued for delivery"}')).toBe('a3f9c1d2');
  });

  it('returns null when the result has no ref or is not JSON', () => {
    expect(sentMessageRefFromToolResult('{"ok":true}')).toBeNull();
    expect(sentMessageRefFromToolResult('not json')).toBeNull();
  });
});

describe('truncateText', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateText('abc', 3)).toEqual({ text: 'abc', cut: false });
  });

  it('cuts to the limit and never leaves a lone high surrogate', () => {
    expect(truncateText('abcdef', 4)).toEqual({ text: 'abcd', cut: true });
    const emoji = 'ab\u{1F600}cd';
    const cut = truncateText(emoji, 3);
    expect(cut.text).toBe('ab');
    expect(cut.cut).toBe(true);
  });
});


describe('truncateHeadTail', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateHeadTail('abc', 3)).toEqual({ text: 'abc', cut: false });
  });

  it('keeps the head and the end, joined by an ellipsis, within the budget', () => {
    const text = `${'a'.repeat(400)}${'b'.repeat(400)}`;
    const result = truncateHeadTail(text, 500);

    expect(result.cut).toBe(true);
    expect(result.text).toBe(`${'a'.repeat(347)} … ${'b'.repeat(150)}`);
    expect(result.text.length).toBe(500);
  });

  it('cuts the head on a word boundary and the tail at the start of a word', () => {
    const text = `${'alpha beta gamma '.repeat(40)}the final question is here?`;
    const result = truncateHeadTail(text, 300);
    const [head = '', tail = ''] = result.text.split(' … ');

    expect(['alpha', 'beta', 'gamma']).toContain(head.split(' ').pop());
    expect(tail.endsWith('the final question is here?')).toBe(true);
    expect(['alpha', 'beta', 'gamma', 'the']).toContain(tail.split(' ')[0]);
  });

  it('never leaves half of a surrogate pair at either cut', () => {
    const text = '\u{1F600}'.repeat(400);
    for (const max of [100, 101, 333, 500]) {
      const { text: cut } = truncateHeadTail(text, max);
      expect(cut.replace(/\u{1F600}/gu, '')).toBe(' … ');
    }
  });
});
