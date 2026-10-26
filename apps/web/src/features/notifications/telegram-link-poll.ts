import type { MeResponse } from '../../lib/api-client.js';
import { chatAddressFor } from '../../lib/chat-addresses.js';

export const TELEGRAM_LINK_POLL_INTERVAL_MS = 2_000;
export const TELEGRAM_LINK_POLL_TIMEOUT_MS = 120_000;

export type TelegramLinkPollResult =
  | { status: 'linked'; me: MeResponse }
  | { status: 'expired' }
  | { status: 'cancelled' };

export interface PollForTelegramLinkOptions {
  fetchMe: (signal: AbortSignal) => Promise<MeResponse>;
  signal: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Polls GET /auth/me until a Telegram chat address appears. Resolves with `expired`
 * once the timeout elapses, and with `cancelled` when the signal aborts. A failed
 * request rejects so the caller can show an error state.
 */
export async function pollForTelegramLink({
  fetchMe,
  signal,
  intervalMs = TELEGRAM_LINK_POLL_INTERVAL_MS,
  timeoutMs = TELEGRAM_LINK_POLL_TIMEOUT_MS,
}: PollForTelegramLinkOptions): Promise<TelegramLinkPollResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await waitForInterval(intervalMs, signal);
    if (signal.aborted) {
      return { status: 'cancelled' };
    }
    const me = await fetchMe(signal);
    if (signal.aborted) {
      return { status: 'cancelled' };
    }
    if (chatAddressFor(me.chatAddresses, 'telegram') !== '') {
      return { status: 'linked', me };
    }
    if (Date.now() >= deadline) {
      return { status: 'expired' };
    }
  }
}

function waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
