import { describe, expect, it, vi } from 'vitest';
import type { ThreadEntry, ThreadReader, ToolContext } from '@herobids/domain';
import { ok, err, CONVERSATION_ERROR_CODES } from '@herobids/domain';
import { conversationReadTools, fitThreadPage, THREAD_BODY_MAX_CHARS, THREAD_OUTPUT_BUDGET_CHARS } from './conversation-read.js';

const getThread = conversationReadTools.find((t) => t.name === 'get_thread')!;
const getMessage = conversationReadTools.find((t) => t.name === 'get_message')!;

const entry = (n: number, body = `message ${n}`): ThreadEntry => ({
  ref: n.toString(16).padStart(8, '0'),
  sender: 'user',
  createdAt: new Date(Date.parse('2026-06-11T06:00:00.000Z') + n * 60_000),
  body,
});

function ctxWith(reader: Partial<ThreadReader> | undefined): ToolContext {
  const threadReader = reader === undefined ? undefined : {
    listPage: vi.fn(async () => ok({ messages: [], hasMore: false })),
    getMessage: vi.fn(async () => ok(null)),
    ...reader,
  } as ThreadReader;
  return { agentId: 'agent-1', sessionId: 's', phase: 'judge', executionMode: 'paper', redis: {} as ToolContext['redis'], publishToInbound: vi.fn(async () => undefined), threadReader } as unknown as ToolContext;
}

describe('get_thread', () => {
  it('returns the page oldest first, with nextBefore and hasMore from the reader', async () => {
    const listPage = vi.fn(async () => ok({ messages: [entry(1), entry(2)], hasMore: true }));
    const result = await getThread.execute({}, ctxWith({ listPage }));

    expect(listPage).toHaveBeenCalledWith({ limit: 5 });
    expect(result).toMatchObject({ success: true, data: { hasMore: true, nextBefore: '00000001' } });
    expect((result.data as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual(['00000001', '00000002']);
  });

  it('passes before and limit to the reader', async () => {
    const listPage = vi.fn(async () => ok({ messages: [], hasMore: false }));
    await getThread.execute({ before: '#0000000a', limit: 3 }, ctxWith({ listPage }));

    expect(listPage).toHaveBeenCalledWith({ before: '#0000000a', limit: 3 });
  });

  it('rejects a before that is not a message id, and a limit outside 1 to 10', async () => {
    expect(await getThread.execute({ before: '%' }, ctxWith({}))).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(await getThread.execute({ limit: 11 }, ctxWith({}))).toMatchObject({ success: false });
  });

  it('reports the thread as unavailable when no reader is bound', async () => {
    expect(await getThread.execute({}, ctxWith(undefined))).toMatchObject({ success: false, errorCode: 'conversation.unavailable' });
  });

  it('passes a store error through', async () => {
    const listPage = vi.fn(async () => err({ code: CONVERSATION_ERROR_CODES.storeFailed, message: 'conversation_store_failed' }));
    expect(await getThread.execute({}, ctxWith({ listPage }))).toMatchObject({ success: false, errorCode: CONVERSATION_ERROR_CODES.storeFailed });
  });
});

describe('fitThreadPage', () => {
  it('caps each body at the body limit and flags it', () => {
    const fitted = fitThreadPage([entry(1, 'x'.repeat(THREAD_BODY_MAX_CHARS + 50))]);

    expect(fitted.messages[0]).toMatchObject({ body: 'x'.repeat(THREAD_BODY_MAX_CHARS), truncated: true });
    expect(fitted.dropped).toBe(false);
  });

  it('drops the oldest messages first when the page exceeds the output budget', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, 'y'.repeat(1000)));
    const fitted = fitThreadPage(entries);

    expect(fitted.dropped).toBe(true);
    expect(JSON.stringify(fitted.messages).length).toBeLessThanOrEqual(THREAD_OUTPUT_BUDGET_CHARS);
    expect(fitted.messages.at(-1)?.id).toBe('0000000a');
  });

  it('reports hasMore when the budget dropped messages, even if the reader had none older', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(i + 1, 'z'.repeat(1000)));
    const result = await getThread.execute({}, ctxWith({ listPage: vi.fn(async () => ok({ messages: entries, hasMore: false })) }));

    expect(result).toMatchObject({ success: true, data: { hasMore: true } });
  });
});

describe('get_message', () => {
  it('returns the full message by id', async () => {
    const getMessageFn = vi.fn(async () => ok(entry(2, 'full text')));
    const result = await getMessage.execute({ id: '#00000002' }, ctxWith({ getMessage: getMessageFn }));

    expect(getMessageFn).toHaveBeenCalledWith('00000002');
    expect(result).toMatchObject({ success: true, data: { message: { id: '00000002', body: 'full text' } } });
  });

  it('answers not found when no message matches', async () => {
    expect(await getMessage.execute({ id: 'deadbeef' }, ctxWith({}))).toMatchObject({ success: false, errorCode: 'conversation.message_not_found' });
  });

  it('reports an ambiguous id with the full ids of its matches, so the model can name one', async () => {
    const getMessageFn = vi.fn(async () => err({ code: CONVERSATION_ERROR_CODES.ambiguousMessageRef, message: 'ambiguous_message_ref', context: { matches: ['a3f9c1d2-1', 'a3f9c1d2-2'] } }));

    expect(await getMessage.execute({ id: 'a3f9c1d2' }, ctxWith({ getMessage: getMessageFn }))).toMatchObject({
      success: false,
      errorCode: CONVERSATION_ERROR_CODES.ambiguousMessageRef,
      error: expect.stringContaining('a3f9c1d2-1, a3f9c1d2-2'),
    });
  });

  it('rejects an id that is not a message id, before it reaches the reader', async () => {
    const getMessageFn = vi.fn();
    expect(await getMessage.execute({ id: '%_' }, ctxWith({ getMessage: getMessageFn }))).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(getMessageFn).not.toHaveBeenCalled();
  });

  it('reports the thread as unavailable when no reader is bound', async () => {
    expect(await getMessage.execute({ id: 'a3f9c1d2' }, ctxWith(undefined))).toMatchObject({ success: false, errorCode: 'conversation.unavailable' });
  });
});
