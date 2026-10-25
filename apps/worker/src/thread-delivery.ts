import {
  CONVERSATION_ERROR_CODES,
  isUserAgentChannel,
  type ConversationService,
  type DomainError,
  type Result,
} from '@herobids/domain';
import type { ChatDeliveryResult } from './alerting/chat-delivery.js';
import { createLogger } from './logger.js';

const logger = createLogger('thread-delivery');

/** Chat errors that mean the message had nowhere to go, so it was not a failed delivery. */
export function isUndeliverableChatError(code: string): boolean {
  return code === 'chat.no_address' || code === 'chat.not_configured';
}

/**
 * Records the outcome of a chat send on the thread row the message was recorded under before the send.
 * A send that reached a chat marks the row `sent` on the channel that carried it. A message with nowhere to go (no
 * address, no chat channel) is `not_applicable`: the thread itself is its delivery. A send on a provider the thread has
 * no channel for is `refused` (and logged). Anything else, including a failed address or suppression lookup (fail
 * closed, I4), is `failed`.
 *
 * Never throws. A repeated mark (`invalid_delivery_transition`) means a worker already marked the row and is not an error.
 */
export async function markThreadDelivery(
  conversations: Pick<ConversationService, 'markDelivery'>,
  messageId: string,
  result: Result<ChatDeliveryResult, DomainError>,
): Promise<void> {
  if (!result.ok) {
    const marked = await conversations.markDelivery({
      messageId,
      status: isUndeliverableChatError(result.error.code) ? 'not_applicable' : 'failed',
      detail: result.error.message,
    });
    logMarkFailure(messageId, marked);
    return;
  }

  const { providerMessageId, address } = result.data;
  if (!isUserAgentChannel(address.provider)) {
    // The thread has no channel for this provider. Marking the row sent would leave it on the channel it was recorded under (web).
    logger.error(
      { messageId, provider: address.provider },
      'Message was sent on a provider the thread has no channel for; marking it refused instead of recording it as web',
    );
    logMarkFailure(messageId, await conversations.markDelivery({
      messageId,
      status: 'refused',
      detail: `no_thread_channel:${address.provider}`,
    }));
    return;
  }
  logMarkFailure(messageId, await conversations.markDelivery({
    messageId,
    status: 'sent',
    providerMessageId,
    channel: address.provider,
  }));
}

function logMarkFailure(messageId: string, marked: Result<unknown, DomainError>): void {
  if (marked.ok) return;
  if (marked.error.code === CONVERSATION_ERROR_CODES.invalidDeliveryTransition) {
    logger.debug({ messageId }, 'Thread message was already marked');
    return;
  }
  logger.error({ messageId, code: marked.error.code }, 'Could not record the delivery outcome on the thread message');
}
