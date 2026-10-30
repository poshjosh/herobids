import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '../../lib/api-client.js';
import { pollForTelegramLink, TELEGRAM_LINK_POLL_INTERVAL_MS, TELEGRAM_LINK_POLL_TIMEOUT_MS } from './telegram-link-poll.js';

function makeMe(telegramAddress: string | null): MeResponse {
  return {
    chatAddresses: telegramAddress === null
      ? []
      : [{ provider: 'telegram', address: telegramAddress, scope: 'user', status: 'active' }],
  } as MeResponse;
}

describe('pollForTelegramLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 2 second interval and a 2 minute timeout by default', () => {
    expect(TELEGRAM_LINK_POLL_INTERVAL_MS).toBe(2_000);
    expect(TELEGRAM_LINK_POLL_TIMEOUT_MS).toBe(120_000);
  });

  it('resolves linked with the profile once a telegram address appears', async () => {
    const linkedMe = makeMe('123456789');
    const fetchMe = vi.fn()
      .mockResolvedValueOnce(makeMe(null))
      .mockResolvedValueOnce(linkedMe);

    const promise = pollForTelegramLink({ fetchMe, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS * 2);

    await expect(promise).resolves.toEqual({ status: 'linked', me: linkedMe });
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });

  it('waits one interval before the first profile request', async () => {
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    void pollForTelegramLink({ fetchMe, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS - 1);
    expect(fetchMe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('resolves expired after the timeout without a telegram address', async () => {
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    const promise = pollForTelegramLink({ fetchMe, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_TIMEOUT_MS);

    await expect(promise).resolves.toEqual({ status: 'expired' });
    expect(fetchMe).toHaveBeenCalledTimes(TELEGRAM_LINK_POLL_TIMEOUT_MS / TELEGRAM_LINK_POLL_INTERVAL_MS);
  });

  it('resolves cancelled and stops polling once the signal aborts', async () => {
    const controller = new AbortController();
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    const promise = pollForTelegramLink({ fetchMe, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS);
    controller.abort();
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_TIMEOUT_MS);

    await expect(promise).resolves.toEqual({ status: 'cancelled' });
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('ignores a link found after cancellation', async () => {
    const controller = new AbortController();
    let resolveRequest: (me: MeResponse) => void = () => {};
    const fetchMe = vi.fn(() => new Promise<MeResponse>((resolve) => { resolveRequest = resolve; }));

    const promise = pollForTelegramLink({ fetchMe, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS);
    controller.abort();
    resolveRequest(makeMe('123456789'));

    await expect(promise).resolves.toEqual({ status: 'cancelled' });
  });

  it('keeps polling after a failed profile request and resolves linked once a later request succeeds', async () => {
    const linkedMe = makeMe('123456789');
    const fetchMe = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(linkedMe);

    const promise = pollForTelegramLink({ fetchMe, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS * 2);

    await expect(promise).resolves.toEqual({ status: 'linked', me: linkedMe });
    expect(fetchMe).toHaveBeenCalledTimes(2);
  });

  it('resolves expired, not rejected, when every profile request fails until the timeout', async () => {
    const fetchMe = vi.fn().mockRejectedValue(new Error('network down'));

    const promise = pollForTelegramLink({ fetchMe, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_TIMEOUT_MS);

    await expect(promise).resolves.toEqual({ status: 'expired' });
  });

  it('passes the abort signal to each profile request so an in-flight request can be cancelled', async () => {
    const controller = new AbortController();
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    const promise = pollForTelegramLink({ fetchMe, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS);
    expect(fetchMe).toHaveBeenCalledWith(controller.signal);

    controller.abort();
    await expect(promise).resolves.toEqual({ status: 'cancelled' });
  });

  it('removes its abort listener after each tick so repeated polls do not accumulate listeners', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    const promise = pollForTelegramLink({ fetchMe, signal: controller.signal, timeoutMs: TELEGRAM_LINK_POLL_INTERVAL_MS * 3 });
    await vi.advanceTimersByTimeAsync(TELEGRAM_LINK_POLL_INTERVAL_MS * 3);

    await expect(promise).resolves.toEqual({ status: 'expired' });
    expect(removeSpy.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(3);
  });

  it('returns cancelled without waiting when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMe = vi.fn().mockResolvedValue(makeMe(null));

    await expect(pollForTelegramLink({ fetchMe, signal: controller.signal })).resolves.toEqual({ status: 'cancelled' });
    expect(fetchMe).not.toHaveBeenCalled();
  });
});
