import { describe, expect, it } from 'vitest';
import { CONVERSATION_ERROR_CODES } from '@herobids/domain';
import {
  ClientMessageIdSchema,
  conversationErrorResponse,
  decodeConversationCursor,
  encodeConversationCursor,
} from './conversation-http.js';

describe('conversation cursor', () => {
  it('round-trips the (createdAt, id) pair', () => {
    const createdAt = new Date('2026-10-25T10:00:00.123Z');

    const cursor = decodeConversationCursor(encodeConversationCursor({ createdAt, id: 'm-1' }));

    expect(cursor).toEqual({ before: createdAt, beforeId: 'm-1' });
  });

  it.each([
    ['not base64 json', 'not-a-cursor'],
    ['json without the pair', Buffer.from('{}').toString('base64url')],
    ['a timestamp that is not a date', Buffer.from(JSON.stringify({ t: 'yesterday', i: 'm-1' })).toString('base64url')],
    ['an empty id', Buffer.from(JSON.stringify({ t: '2026-10-25T10:00:00.000Z', i: '' })).toString('base64url')],
    ['an oversized id', Buffer.from(JSON.stringify({ t: '2026-10-25T10:00:00.000Z', i: 'x'.repeat(129) })).toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(decodeConversationCursor(raw)).toBeNull();
  });
});

describe('ClientMessageIdSchema', () => {
  it('accepts a UUID and nothing else', () => {
    expect(ClientMessageIdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(ClientMessageIdSchema.safeParse('user_agent:agent-1').success).toBe(false);
    expect(ClientMessageIdSchema.safeParse('').success).toBe(false);
    expect(ClientMessageIdSchema.safeParse(`${crypto.randomUUID()}${'0'.repeat(100)}`).success).toBe(false);
  });
});

describe('conversationErrorResponse', () => {
  const error = (code: string) => conversationErrorResponse({ code, message: code });

  it('maps input errors to 400, an id clash to 409 and an owner mismatch to 404', () => {
    expect(error(CONVERSATION_ERROR_CODES.invalidMessage).status).toBe(400);
    expect(error(CONVERSATION_ERROR_CODES.bodyTooLong).status).toBe(400);
    expect(error(CONVERSATION_ERROR_CODES.invalidCursor).status).toBe(400);
    expect(error(CONVERSATION_ERROR_CODES.messageIdConflict).status).toBe(409);
    expect(error(CONVERSATION_ERROR_CODES.ownerMismatch)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('fails closed with 503 for a store failure and for any code it does not know, without leaking context', () => {
    const storeFailed = conversationErrorResponse({ code: CONVERSATION_ERROR_CODES.storeFailed, message: 'x', context: { cause: 'secret' } });
    const unknown = error('something.else');

    expect(storeFailed.status).toBe(503);
    expect(JSON.stringify(storeFailed.body)).not.toContain('secret');
    expect(unknown.status).toBe(503);
  });
});
