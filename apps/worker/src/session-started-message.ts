import type { ConversationService } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { ChatDelivery } from './alerting/chat-delivery.js';
import { isUndeliverableChatError, markThreadDelivery } from './thread-delivery.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-started-message');

export interface SessionStartedMessageDeps {
  agents: Pick<AgentRepository, 'getAgent'>;
  conversations: Pick<ConversationService, 'recordPlatformMessage' | 'markDelivery'>;
  chatDelivery: Pick<ChatDelivery, 'send'>;
}

export function sessionStartedText(agentName: string): string {
  return `${agentName} is now ready for your instructions. Reply to this message to instruct it what to do.`;
}

/**
 * Posts the "<agent> is now ready" message when a session starts. The web thread is the primary channel, so the
 * message is always recorded there first. Telegram is an extra copy that also anchors reply routing: it is sent only
 * when the owner has a chat address and the bot is configured. Otherwise the row is marked `not_applicable`.
 * Bug: docs/bug-reports/2026/11/15/002-session-started-message-gated-on-telegram.md
 */
export async function announceSessionStarted(deps: SessionStartedMessageDeps, agentId: string): Promise<void> {
  const agent = await deps.agents.getAgent(agentId);
  if (!agent) {
    logger.warn({ agentId }, 'Agent not found; session-started message not sent');
    return;
  }

  const text = sessionStartedText(agent.name);
  const recorded = await deps.conversations.recordPlatformMessage({
    ownerUserId: agent.userId,
    agentId,
    channel: 'web',
    subject: 'Session started',
    body: text,
    messageClass: 'reminder',
  });
  if (!recorded.ok) {
    logger.error({ agentId, code: recorded.error.code }, 'Could not record the session-started message in the thread; not sent');
    return;
  }

  const result = await deps.chatDelivery.send(agentId, { body: text, replyRequested: true });
  await markThreadDelivery(deps.conversations, recorded.data.message.id, result);
  if (!result.ok && !isUndeliverableChatError(result.error.code)) {
    logger.warn({ agentId, error: result.error }, 'Failed to send the session-started message to Telegram');
  }
}
