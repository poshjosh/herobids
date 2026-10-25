import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_ERROR_CODES } from '@herobids/domain';
import { isUndeliverableChatError, markThreadDelivery } from './thread-delivery.js';

const logError = vi.hoisted(() => vi.fn());
vi.mock('./logger.js', () => ({ createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));

const sent = { ok: true as const, data: { providerMessageId: 'tg-1', address: { provider: 'telegram', address: '123' } } };

function conversations(result: unknown = { ok: true, data: {} }) {
  return { markDelivery: vi.fn().mockResolvedValue(result) };
}

describe('markThreadDelivery', () => {
  it('marks a send sent on the channel that carried it, with the provider message id', async () => {
    const store = conversations();

    await markThreadDelivery(store as never, 'm1', sent as never);

    expect(store.markDelivery).toHaveBeenCalledWith({ messageId: 'm1', status: 'sent', providerMessageId: 'tg-1', channel: 'telegram' });
  });

  it('refuses and logs, rather than recording the row as web, when the provider is not a thread channel', async () => {
    logError.mockClear();
    const store = conversations();
    const result = { ...sent, data: { ...sent.data, address: { provider: 'sms', address: '+1555' } } };

    await markThreadDelivery(store as never, 'm1', result as never);

    expect(store.markDelivery).toHaveBeenCalledTimes(1);
    expect(store.markDelivery).toHaveBeenCalledWith({ messageId: 'm1', status: 'refused', detail: 'no_thread_channel:sms' });
    expect(logError).toHaveBeenCalledWith({ messageId: 'm1', provider: 'sms' }, expect.any(String));
  });

  it.each(['chat.no_address', 'chat.not_configured'])('marks %s not applicable', async (code) => {
    const store = conversations();

    await markThreadDelivery(store as never, 'm1', { ok: false, error: { code, message: 'nowhere' } });

    expect(store.markDelivery).toHaveBeenCalledWith({ messageId: 'm1', status: 'not_applicable', detail: 'nowhere' });
  });

  it.each(['chat.address_lookup_failed', 'chat.address_suppressed', 'tg.error'])('marks %s failed', async (code) => {
    const store = conversations();

    await markThreadDelivery(store as never, 'm1', { ok: false, error: { code, message: 'boom' } });

    expect(store.markDelivery).toHaveBeenCalledWith({ messageId: 'm1', status: 'failed', detail: 'boom' });
  });

  it('logs an error when the mark fails, and does not throw', async () => {
    logError.mockClear();
    const store = conversations({ ok: false, error: { code: CONVERSATION_ERROR_CODES.storeFailed, message: 'down' } });

    await expect(markThreadDelivery(store as never, 'm1', sent as never)).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith({ messageId: 'm1', code: CONVERSATION_ERROR_CODES.storeFailed }, expect.any(String));
  });

  it('treats a repeated mark as already done, without an error', async () => {
    logError.mockClear();
    const store = conversations({ ok: false, error: { code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition, message: 'x' } });

    await markThreadDelivery(store as never, 'm1', sent as never);

    expect(logError).not.toHaveBeenCalled();
  });
});

describe('isUndeliverableChatError', () => {
  it('is true only for a message with nowhere to go', () => {
    expect(isUndeliverableChatError('chat.no_address')).toBe(true);
    expect(isUndeliverableChatError('chat.not_configured')).toBe(true);
    expect(isUndeliverableChatError('chat.address_suppressed')).toBe(false);
  });
});
