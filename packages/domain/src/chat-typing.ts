import type { ChatAddress } from './ports/chat-channel.js';

/**
 * Lifetime of the stop signal a worker writes after replying. The TTL must exceed the
 * maximum refresh interval (typingRefreshIntervalMs, capped at 9000 ms) so the next refresh tick sees it.
 */
export const CHAT_TYPING_STOP_TTL_SECONDS = 10;

/** Redis key the worker sets after delivering a reply and the API checks before each typing refresh. */
export function chatTypingStopKey(address: Pick<ChatAddress, 'provider' | 'address'>): string {
  return `chat:typing:stop:${address.provider}:${address.address}`;
}
