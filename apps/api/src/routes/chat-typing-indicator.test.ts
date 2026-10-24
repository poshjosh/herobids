import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChannel } from '@herobids/domain';
import { ChatTypingIndicator, createTelegramTypingSender, type ChatTypingSenders } from './chat-typing-indicator.js';

const CHAT = { provider: 'telegram', address: '123' };
const OTHER_CHAT = { provider: 'telegram', address: '456' };
const STOP_KEY = 'chat:typing:stop:telegram:123';
const timing = { refreshIntervalMs: 4000, maxWindowMs: 10000 };

function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
  return { redis, store };
}

function indicatorWith(
  sendTyping: NonNullable<ChatChannel['sendTyping']>,
  logger?: { warn: (context: Record<string, unknown>, message: string) => void },
  redis = fakeRedis().redis,
): ChatTypingIndicator {
  const senders: ChatTypingSenders = new Map([['telegram', { sendTyping }]]);
  return new ChatTypingIndicator(senders, timing, redis, logger);
}

describe('ChatTypingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends the typing action as soon as an agent starts working on a message', () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith(CHAT);
    indicator.dispose();
  });

  it('refreshes the typing action on each interval until the window closes', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(10000);

    expect(sendTyping).toHaveBeenCalledTimes(3);
    indicator.dispose();
  });

  it('stops refreshing once the window elapses', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(20000);

    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the window when another message arrives in the same chat instead of stacking refreshers', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(6000);
    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(9000);

    expect(sendTyping).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(2);
    indicator.dispose();
  });

  it('keeps refreshing after a typing action returns an error and logs it', async () => {
    const sendTyping = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'telegram.http_error', message: 'HTTP 500' } })
      .mockResolvedValue({ ok: true, data: undefined });
    const logger = { warn: vi.fn() };
    const indicator = indicatorWith(sendTyping, logger);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(4000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'telegram.http_error' }), 'Typing indicator failed');
    indicator.dispose();
  });

  it('keeps refreshing after a typing action throws', async () => {
    const sendTyping = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ ok: true, data: undefined });
    const logger = { warn: vi.fn() };
    const indicator = indicatorWith(sendTyping, logger);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(4000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'socket hang up' }), 'Typing indicator failed');
    indicator.dispose();
  });

  it('does nothing for a provider without a typing action', () => {
    const senders: ChatTypingSenders = new Map([['telegram', {}]]);
    const indicator = new ChatTypingIndicator(senders, timing, fakeRedis().redis);

    expect(() => indicator.start(CHAT)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    indicator.dispose();
  });

  it('stops every active refresher when disposed', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);
    indicator.start(OTHER_CHAT);
    indicator.dispose();
    await vi.advanceTimersByTimeAsync(20000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends the Telegram typing action to the chat and returns the Telegram error on rejection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, description: 'chat not found' }) });
    vi.stubGlobal('fetch', fetchMock);
    const sender = createTelegramTypingSender('test-token');

    const accepted = await sender.sendTyping(CHAT);
    const rejected = await sender.sendTyping(CHAT);

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.telegram.org/bottest-token/sendChatAction', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ chat_id: '123', action: 'typing' });
    expect(accepted).toEqual({ ok: true, data: undefined });
    expect(rejected).toEqual({ ok: false, error: { code: 'telegram.api_error', message: 'chat not found' } });
  });
});

describe('ChatTypingIndicator stop signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops typing once the worker stop signal is present', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const { redis, store } = fakeRedis();
    const indicator = indicatorWith(sendTyping, undefined, redis);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(4000);
    store.set(STOP_KEY, '1');
    await vi.advanceTimersByTimeAsync(4000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a stop signal written before a new inbound message', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const { redis, store } = fakeRedis({ [STOP_KEY]: '1' });
    const indicator = indicatorWith(sendTyping, undefined, redis);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(8000);

    expect(redis.del).toHaveBeenCalledWith(STOP_KEY);
    expect(store.has(STOP_KEY)).toBe(false);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(2);
    indicator.dispose();
  });

  it('keeps typing when the stop check throws', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const logger = { warn: vi.fn() };
    const redis = { get: vi.fn().mockRejectedValue(new Error('redis down')), del: vi.fn().mockResolvedValue(0) };
    const indicator = indicatorWith(sendTyping, logger, redis);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(8000);

    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'redis down' }), 'Typing stop check failed');
    indicator.dispose();
  });

  it('keeps typing when the stop-key read never resolves, without blocking the next typing action', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const logger = { warn: vi.fn() };
    const { redis } = fakeRedis();
    redis.get.mockReturnValue(new Promise<string | null>(() => {}));
    const indicator = indicatorWith(sendTyping, logger, redis);

    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith({ provider: 'telegram' }, 'Typing stop check timed out');

    await vi.advanceTimersByTimeAsync(4000);

    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(2);
    indicator.dispose();
  });

  it('keeps typing when clearing the stale stop signal throws', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const redis = { get: vi.fn().mockResolvedValue(null), del: vi.fn().mockRejectedValue(new Error('redis down')) };
    const indicator = indicatorWith(sendTyping, { warn: vi.fn() }, redis);

    expect(() => indicator.start(CHAT)).not.toThrow();
    await vi.advanceTimersByTimeAsync(4000);

    expect(sendTyping).toHaveBeenCalledTimes(2);
    indicator.dispose();
  });

  it('does not start a session after dispose', async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.dispose();
    indicator.start(CHAT);
    await vi.advanceTimersByTimeAsync(20000);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates refresh and window timers that do not keep the process alive', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const sendTyping = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    const indicator = indicatorWith(sendTyping);

    indicator.start(CHAT);

    const refresh = intervalSpy.mock.results.at(-1)?.value as { hasRef(): boolean };
    const expire = timeoutSpy.mock.results.at(-1)?.value as { hasRef(): boolean };
    expect(refresh.hasRef()).toBe(false);
    expect(expire.hasRef()).toBe(false);
    indicator.dispose();
    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('aborts the Telegram typing request after a timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: true }) });
    vi.stubGlobal('fetch', fetchMock);

    await createTelegramTypingSender('test-token').sendTyping(CHAT);

    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
