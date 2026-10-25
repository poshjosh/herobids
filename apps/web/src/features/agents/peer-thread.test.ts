import { describe, it, expect } from 'vitest';
import type { PeerMessage } from '../../lib/api-client.js';
import { GENERIC_REFUSAL_KEY, mergePeerMessages, peerMessageSide, refusalReasonKey } from './peer-thread.js';

function message(id: string, createdAt: string, overrides: Partial<PeerMessage> = {}): PeerMessage {
  return {
    id,
    senderType: 'agent',
    senderId: 'agent-a',
    channel: 'internal',
    subject: null,
    body: `body ${id}`,
    messageClass: null,
    deliveryStatus: 'sent',
    createdAt,
    stuck: false,
    refusalReason: null,
    ...overrides,
  };
}

describe('peerMessageSide', () => {
  it('attributes a message sent by the viewed agent to itself', () => {
    expect(peerMessageSide(message('m1', '2026-01-01T00:00:00Z'), 'agent-a')).toBe('self');
  });

  it('attributes a message sent by another agent to the peer', () => {
    expect(peerMessageSide(message('m1', '2026-01-01T00:00:00Z', { senderId: 'agent-b' }), 'agent-a')).toBe('peer');
  });

  it('attributes a message with no sender id to the peer', () => {
    expect(peerMessageSide(message('m1', '2026-01-01T00:00:00Z', { senderId: null }), 'agent-a')).toBe('peer');
  });
});

describe('refusalReasonKey', () => {
  it.each([
    ['peer.paused', 'agentDetail.peerThreads.refusal.paused'],
    ['peer.rate_limited', 'agentDetail.peerThreads.refusal.rateLimited'],
    ['peer.recipient_not_running', 'agentDetail.peerThreads.refusal.recipientNotRunning'],
    ['peer.unavailable', 'agentDetail.peerThreads.refusal.unavailable'],
  ])('maps the known code %s to its own message', (code, key) => {
    expect(refusalReasonKey(code)).toBe(key);
  });

  it('falls back to the generic message for an unknown code', () => {
    expect(refusalReasonKey('peer.something_new')).toBe(GENERIC_REFUSAL_KEY);
  });

  it('falls back to the generic message when no code is given', () => {
    expect(refusalReasonKey(null)).toBe(GENERIC_REFUSAL_KEY);
  });

  it('does not resolve inherited object properties as codes', () => {
    expect(refusalReasonKey('constructor')).toBe(GENERIC_REFUSAL_KEY);
  });
});

describe('mergePeerMessages', () => {
  it('orders merged pages oldest first', () => {
    const merged = mergePeerMessages(
      [message('m3', '2026-01-03T00:00:00Z')],
      [message('m1', '2026-01-01T00:00:00Z'), message('m2', '2026-01-02T00:00:00Z')],
    );
    expect(merged.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps the later copy of a message that appears in both pages', () => {
    const merged = mergePeerMessages(
      [message('m1', '2026-01-01T00:00:00Z', { deliveryStatus: 'queued' })],
      [message('m1', '2026-01-01T00:00:00Z', { deliveryStatus: 'sent' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.deliveryStatus).toBe('sent');
  });

  it('breaks timestamp ties by id', () => {
    const merged = mergePeerMessages([message('b', '2026-01-01T00:00:00Z'), message('a', '2026-01-01T00:00:00Z')]);
    expect(merged.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
