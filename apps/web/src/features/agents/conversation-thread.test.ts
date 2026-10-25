import { describe, expect, it } from 'vitest';
import type { AgentConversationMessage } from '../../lib/api-client.js';
import { buildThread, mergeMessages, type PendingSend } from './conversation-thread.js';

function message(id: string, createdAt: string, overrides: Partial<AgentConversationMessage> = {}): AgentConversationMessage {
  return {
    id,
    senderType: 'agent',
    senderId: 'agent-1',
    channel: 'web',
    subject: null,
    body: id,
    messageClass: null,
    deliveryStatus: 'sent',
    createdAt,
    ...overrides,
  };
}

describe('mergeMessages', () => {
  it('orders oldest first and breaks ties by id', () => {
    const merged = mergeMessages([message('b', '2026-10-25T10:00:00.000Z'), message('c', '2026-10-25T10:00:01.000Z')], [message('a', '2026-10-25T10:00:00.000Z')]);

    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps one row per id and lets the later list win, so a status change replaces the stored row', () => {
    const merged = mergeMessages(
      [message('u1', '2026-10-25T10:00:00.000Z', { deliveryStatus: 'queued' })],
      [message('u1', '2026-10-25T10:00:00.000Z', { deliveryStatus: 'sent' })],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.deliveryStatus).toBe('sent');
  });

  it('keeps rows that slid out of the polled window', () => {
    const first = [message('m1', '2026-10-25T10:00:00.000Z'), message('m2', '2026-10-25T10:00:01.000Z')];
    const slid = [message('m2', '2026-10-25T10:00:01.000Z'), message('m3', '2026-10-25T10:00:02.000Z')];

    expect(mergeMessages(first, slid).map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('buildThread', () => {
  const history = [message('m1', '2026-10-25T10:00:00.000Z'), message('u1', '2026-10-25T10:00:01.000Z', { senderType: 'user', senderId: 'user-1', deliveryStatus: 'failed' })];

  it('appends unconfirmed local sends after the confirmed rows as queued or failed user messages', () => {
    const pending: PendingSend[] = [
      { id: 'p1', body: 'sending now', createdAt: '2026-10-25T10:00:05.000Z', status: 'sending' },
      { id: 'p2', body: 'did not go', createdAt: '2026-10-25T10:00:06.000Z', status: 'failed' },
    ];

    const thread = buildThread(history, pending);

    expect(thread.map((entry) => entry.id)).toEqual(['m1', 'u1', 'p1', 'p2']);
    expect(thread[2]).toMatchObject({ senderType: 'user', channel: 'web', body: 'sending now', deliveryStatus: 'queued' });
    expect(thread[3]).toMatchObject({ body: 'did not go', deliveryStatus: 'failed' });
  });

  it('shows a retry in flight on the stored failed row in its place, without duplicating it', () => {
    const thread = buildThread(history, [{ id: 'u1', body: 'u1', createdAt: '2026-10-25T10:01:00.000Z', status: 'sending' }]);

    expect(thread.map((entry) => entry.id)).toEqual(['m1', 'u1']);
    expect(thread[1]?.deliveryStatus).toBe('queued');
  });

  it('does not override a stored sent status with a failed local attempt', () => {
    const delivered = [message('u2', '2026-10-25T10:00:02.000Z', { senderType: 'user', senderId: 'user-1', deliveryStatus: 'sent' })];

    const thread = buildThread(delivered, [{ id: 'u2', body: 'u2', createdAt: '2026-10-25T10:01:00.000Z', status: 'failed' }]);

    expect(thread).toEqual(delivered);
  });

  it.each(['sent', 'refused', 'not_applicable'] as const)('does not override a stored %s status with a retry in flight', (deliveryStatus) => {
    const stored = [message('u2', '2026-10-25T10:00:02.000Z', { senderType: 'user', senderId: 'user-1', deliveryStatus })];

    expect(buildThread(stored, [{ id: 'u2', body: 'u2', createdAt: '2026-10-25T10:01:00.000Z', status: 'sending' }])).toEqual(stored);
  });

  it('lets a retry in flight override a stuck queued row and clears its stuck flag', () => {
    const stuck = [message('u3', '2026-10-25T10:00:02.000Z', { senderType: 'user', senderId: 'user-1', deliveryStatus: 'queued', stuck: true })];

    const thread = buildThread(stuck, [{ id: 'u3', body: 'u3', createdAt: '2026-10-25T10:01:00.000Z', status: 'sending' }]);

    expect(thread[0]).toMatchObject({ deliveryStatus: 'queued', stuck: false });
  });

  it('returns the confirmed rows untouched when nothing is pending', () => {
    expect(buildThread(history, [])).toEqual(history);
  });
});
