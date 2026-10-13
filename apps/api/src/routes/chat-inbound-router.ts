import type { ChatAddress, InboundChatMessage } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';
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
  resolveReply: (providerMessageId: string, address: ChatAddress) => Promise<(RoutableAgent & { userId: string }) | null>;
  listAgents: (userId: string) => Promise<RoutableAgent[]>;
  sendText: (address: ChatAddress, text: string) => Promise<void>;
}

function canReceive(status: string): boolean {
  return status !== 'stopped' && status !== 'crashed';
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

  async deliver(agentId: string, userId: string, messageText: string, redis: Redis): Promise<void> {
    const envelope = {
      schemaVersion: 'v1', messageId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      initiatorType: 'user', initiatorId: userId, agentId, type: 'user.message',
      createdAt: new Date().toISOString(), payload: { message: messageText },
    };
    await redis.xadd(`agent:outbound:${agentId}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));
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
      await this.deliver(agent.agentId, agent.userId, message.text!.trim(), deps.redis);
      await deps.sendText(address, `Delivered to ${agent.agentName}.`);
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
          await this.deliver(agent.agentId, userId, body, deps.redis);
          confirmations.push(`Delivered to ${agent.agentName}.`);
        }
      }
      await deps.sendText(address, confirmations.join('\n'));
      return;
    }

    const runningAgents = userAgents.filter((agent) => canReceive(agent.status));
    if (runningAgents.length === 1) {
      await this.deliver(runningAgents[0]!.agentId, userId, body, deps.redis);
      await deps.sendText(address, `Delivered to ${runningAgents[0]!.agentName}.`);
    } else if (runningAgents.length === 0) {
      await deps.sendText(address, 'No running agents found. Start an agent or reply to one of its Telegram messages.');
    } else {
      await deps.sendText(address, 'Multiple running agents found. Use /to <agent name> <message> to choose a target.');
    }
  }
}