import {
  CONVERSATION_CHANNELS,
  type ConversationService,
  type UserAgentChannel,
} from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import { createLogger } from '../logger.js';

const logger = createLogger('outbound-conversation-mirror');

type MirrorRepository = Pick<AgentRepository, 'getAgent' | 'getOutboundMessage'>;
type MirrorService = Pick<ConversationService, 'recordAgentMessage' | 'recordPlatformMessage'>;

function isUserAgentChannel(value: string | null): value is UserAgentChannel {
  return value !== null && value !== 'internal' && (CONVERSATION_CHANNELS as readonly string[]).includes(value);
}

/**
 * Transitional (CH2W P2 to P3). Copies an agent or platform row of `agent_outbound_messages` into the
 * conversation, under the same id, once its delivery outcome is known (recorded with that outcome in one insert), so the web chat shows replies while
 * the broker, alert service and session anchor still write the old table. P3 moves those writers onto
 * ConversationService and deletes this class. It never throws: the old table remains the delivery record.
 */
export class OutboundConversationMirror {
  constructor(
    private readonly agentRepo: MirrorRepository,
    private readonly conversations: MirrorService,
  ) {}

  /**
   * `outcome: 'not_applicable'` is for a message that was never sent anywhere because there was nowhere to send it
   * (`chat.no_address`, `chat.not_configured`; see `isUndeliverableChatError`). The old row may say `failed` for
   * those, but the thread must not show them as failures: the in-app thread is the delivery.
   */
  async mirror(outboundMessageId: string, outcome?: 'not_applicable'): Promise<void> {
    try {
      const row = await this.agentRepo.getOutboundMessage(outboundMessageId);
      if (!row || (row.authoredBy !== 'agent' && row.authoredBy !== 'platform')) return;
      const agent = await this.agentRepo.getAgent(row.agentId);
      if (!agent) return;

      // The row is recorded with its final outcome in one insert, so it is never left `queued`. A row that still
      // says `pending` had no delivery attempt, so it is not applicable too.
      const deliveryStatus = outcome === 'not_applicable' ? 'not_applicable' as const
        : row.deliveryStatus === 'sent' ? 'sent' as const
        : row.deliveryStatus === 'failed' ? 'failed' as const
        : 'not_applicable' as const;
      const base = {
        id: row.id,
        ownerUserId: agent.userId,
        agentId: row.agentId,
        channel: isUserAgentChannel(row.deliveryProvider) ? row.deliveryProvider : 'web',
        subject: row.subject,
        body: row.body,
        messageClass: row.messageClass,
        deliveryStatus,
        ...(deliveryStatus === 'sent' ? { providerMessageId: row.providerMessageId } : {}),
        ...(deliveryStatus === 'failed' ? { deliveryDetail: row.deliveryError } : {}),
      };
      const recorded = row.authoredBy === 'agent'
        ? await this.conversations.recordAgentMessage(base)
        : await this.conversations.recordPlatformMessage(base);
      if (!recorded.ok) {
        logger.error({ agentId: row.agentId, outboundMessageId, code: recorded.error.code }, 'Could not mirror outbound message into the conversation');
      }
    } catch (error) {
      logger.error({ outboundMessageId, error: error instanceof Error ? error.name : 'NonError' }, 'Outbound message mirror failed');
    }
  }
}

/** Chat errors that mean the message had nowhere to go, so it was not a failed delivery. */
export function isUndeliverableChatError(code: string): boolean {
  return code === 'chat.no_address' || code === 'chat.not_configured';
}
