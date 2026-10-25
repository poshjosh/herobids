import type { ChatAddress, ConversationService, InboundChatMessage } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN, CONVERSATION_ERROR_CODES, isUserAgentChannel } from '@herobids/domain';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { parseTelegramCommand } from './telegram-command-parser.js';
import { parseSlashCommand } from './telegram-slash-commands.js';

interface RoutableAgent {
  agentId: string;
  agentName: string;
  status: string;
}

interface ChatInboundDependencies {
  redis: Redis;
  /** Records each inbound user message in the agent's conversation before it is published (CH2W P3). */
  conversations: Pick<ConversationService, 'recordUserMessage' | 'markDelivery'>;
  log?: {
    warn: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
  resolveReply: (providerMessageId: string, address: ChatAddress) => Promise<(RoutableAgent & { userId: string }) | null>;
  listAgents: (userId: string) => Promise<RoutableAgent[]>;
  sendText: (address: ChatAddress, text: string) => Promise<void>;
  /** Called once an agent has been delivered a message; sent after the acknowledgement because sending a message clears typing. */
  startTyping?: (address: ChatAddress) => void;
}

function canReceive(status: string): boolean {
  return status !== 'stopped' && status !== 'crashed';
}

type DeliverOutcome = { ok: true } | { ok: false; reply: string };

/** Attempts (first try included) to mark a published message as sent before giving up. */
const MARK_SENT_ATTEMPTS = 3;

/**
 * Row id for a provider message delivered to one agent: the same provider message to the same agent always maps to
 * the same id, so a redelivered webhook finds its row instead of creating (and publishing) a second one. The agent is
 * part of the key because one message can target several agents.
 */
function inboundMessageId(message: InboundChatMessage, agentId: string): string | undefined {
  if (!message.providerMessageId) return undefined;
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([message.from.provider, message.from.address, message.providerMessageId, agentId]))
    .digest('hex');
  return `chat-inbound-${digest.slice(0, 40)}`;
}

export class ChatInboundRouter {
  route(message: InboundChatMessage) {
    const text = message.text?.trim() ?? '';
    const slash = parseSlashCommand(text);
    if (slash && slash.command !== 'to') return { kind: 'slash' as const, command: slash };
    if (message.inReplyToProviderMessageId) {
      return { kind: 'reply' as const, providerMessageId: message.inReplyToProviderMessageId };
    }
    const target = parseTelegramCommand(text);
    if (target?.targets.length) return { kind: 'target' as const, command: target, body: target.body.trim() };
    return { kind: 'plain' as const, body: target?.body.trim() ?? text };
  }

  /** Publishes to the agent without recording a conversation row: for platform-composed notices, not user text. */
  async deliver(agentId: string, userId: string, messageText: string, redis: Redis, messageId: string = crypto.randomUUID()): Promise<void> {
    const envelope = {
      schemaVersion: 'v1', messageId, correlationId: crypto.randomUUID(),
      initiatorType: 'user', initiatorId: userId, agentId, type: 'user.message',
      createdAt: new Date().toISOString(), payload: { message: messageText },
    };
    await redis.xadd(`agent:outbound:${agentId}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));
  }

  /**
   * Records the user's chat message in the agent's conversation, then publishes it under the row id and marks the
   * delivery (the web route's order, 002 D6). When the message cannot be recorded it is not published, and the
   * reply to send back to the user says why.
   */
  private async deliverUserMessage(
    address: ChatAddress,
    agent: RoutableAgent,
    userId: string,
    messageText: string,
    deps: ChatInboundDependencies,
    inboundId?: string,
  ): Promise<DeliverOutcome> {
    const unavailable: DeliverOutcome = { ok: false, reply: `Could not deliver your message to ${agent.agentName}. Please try again.` };
    // A provider the thread has no channel for is refused rather than recorded under the wrong channel.
    if (!isUserAgentChannel(address.provider)) {
      deps.log?.warn({ agentId: agent.agentId, provider: address.provider }, 'chat inbound provider has no conversation channel');
      return unavailable;
    }
    const recorded = await deps.conversations.recordUserMessage({
      ownerUserId: userId,
      agentId: agent.agentId,
      channel: address.provider,
      body: messageText,
      ...(inboundId ? { id: inboundId } : {}),
    });
    if (!recorded.ok) {
      if (recorded.error.code === CONVERSATION_ERROR_CODES.bodyTooLong) {
        const maxChars = recorded.error.context?.['maxChars'];
        return { ok: false, reply: `Your message is too long${typeof maxChars === 'number' ? ` (the limit is ${maxChars} characters)` : ''}. Please shorten it and send it again.` };
      }
      deps.log?.warn({ agentId: agent.agentId, code: recorded.error.code }, 'chat inbound message could not be recorded');
      return unavailable;
    }
    const messageId = recorded.data.message.id;
    if (!recorded.data.created) {
      // A redelivered message. Already sent: the agent has it. Queued: an earlier attempt stopped before it was
      // marked, so publish under the same id. Any other state is final and is not retried.
      const { deliveryStatus } = recorded.data.message;
      if (deliveryStatus === 'sent') return { ok: true };
      if (deliveryStatus !== 'queued') {
        deps.log?.warn({ agentId: agent.agentId, deliveryStatus }, 'chat inbound redelivery of a message that is not queued');
        return unavailable;
      }
    }
    try {
      await this.deliver(agent.agentId, userId, messageText, deps.redis, messageId);
    } catch (error) {
      deps.log?.warn({ agentId: agent.agentId, error: error instanceof Error ? error.name : 'NonError' }, 'chat inbound message publish failed');
      const marked = await deps.conversations.markDelivery({ messageId, status: 'failed', detail: 'publish_failed' });
      if (!marked.ok) deps.log?.warn({ agentId: agent.agentId, code: marked.error.code }, 'could not mark chat inbound message as failed');
      return unavailable;
    }
    await this.markSent(agent.agentId, messageId, deps);
    return { ok: true };
  }

  /** The agent already has the message, so a failed mark never fails the delivery; it is retried a bounded number of times, then logged. */
  private async markSent(agentId: string, messageId: string, deps: ChatInboundDependencies): Promise<void> {
    let code = 'unknown';
    for (let attempt = 1; attempt <= MARK_SENT_ATTEMPTS; attempt += 1) {
      try {
        const sent = await deps.conversations.markDelivery({ messageId, status: 'sent' });
        // Not queued any more: an earlier attempt's mark landed.
        if (sent.ok || sent.error.code === CONVERSATION_ERROR_CODES.invalidDeliveryTransition) return;
        code = sent.error.code;
      } catch (error) {
        code = error instanceof Error ? error.name : 'NonError';
      }
    }
    deps.log?.error({ agentId, messageId, code, attempts: MARK_SENT_ATTEMPTS }, 'could not mark published chat inbound message as sent; the thread shows it as queued');
  }

  async dispatch(message: InboundChatMessage, userId: string | undefined, deps: ChatInboundDependencies): Promise<void> {
    const address = message.from;
    const route = this.route(message);
    if (route.kind === 'slash') return;

    if (route.kind === 'reply') {
      const agent = await deps.resolveReply(route.providerMessageId, address);
      if (!agent) {
        await deps.sendText(address, "I couldn't find which agent that reply belongs to. The message may be too old.");
        return;
      }
      if (!canReceive(agent.status)) {
        await deps.sendText(address, `Agent ${agent.agentName} is stopped and cannot receive messages right now.`);
        return;
      }
      const outcome = await this.deliverUserMessage(address, agent, agent.userId, message.text!.trim(), deps, inboundMessageId(message, agent.agentId));
      if (!outcome.ok) {
        await deps.sendText(address, outcome.reply);
        return;
      }
      await deps.sendText(address, `Delivered to ${agent.agentName}.`);
      deps.startTyping?.(address);
      return;
    }

    if (!userId) return;
    const userAgents = await deps.listAgents(userId);
    const body = route.body;
    if (route.kind === 'target' && route.command.targets.length) {
      if (!body) {
        await deps.sendText(address, 'Please include a message after the target.');
        return;
      }
      const confirmations: string[] = [];
      const deliveredAgentIds = new Set<string>();
      let anyDelivered = false;
      for (const target of route.command.targets) {
        const isBroadcast = target === '*' || target.toLowerCase() === 'all';
        const targetAgents = isBroadcast
          ? userAgents.filter((agent) => canReceive(agent.status))
          : userAgents.filter((agent) => agent.agentName.toLowerCase() === target.toLowerCase());
        if (!targetAgents.length) {
          confirmations.push(isBroadcast ? 'No running agents found.' : `No agent named ${target} found.`);
          continue;
        }
        for (const agent of targetAgents) {
          if (deliveredAgentIds.has(agent.agentId)) continue;
          deliveredAgentIds.add(agent.agentId);
          if (!canReceive(agent.status)) {
            confirmations.push(`Agent ${agent.agentName} is stopped and cannot receive messages right now.`);
            continue;
          }
          const outcome = await this.deliverUserMessage(address, agent, userId, body, deps, inboundMessageId(message, agent.agentId));
          if (!outcome.ok) {
            confirmations.push(outcome.reply);
            continue;
          }
          anyDelivered = true;
          confirmations.push(`Delivered to ${agent.agentName}.`);
        }
      }
      await deps.sendText(address, confirmations.join('\n'));
      if (anyDelivered) deps.startTyping?.(address);
      return;
    }

    const runningAgents = userAgents.filter((agent) => canReceive(agent.status));
    if (runningAgents.length === 1) {
      const target = runningAgents[0]!;
      const outcome = await this.deliverUserMessage(address, target, userId, body, deps, inboundMessageId(message, target.agentId));
      if (!outcome.ok) {
        await deps.sendText(address, outcome.reply);
        return;
      }
      await deps.sendText(address, `Delivered to ${target.agentName}.`);
      deps.startTyping?.(address);
    } else if (runningAgents.length === 0) {
      await deps.sendText(address, 'No running agents found. Start an agent or reply to one of its Telegram messages.');
    } else {
      await deps.sendText(address, 'Multiple running agents found. Use /to <agent name> <message> to choose a target.');
    }
  }
}