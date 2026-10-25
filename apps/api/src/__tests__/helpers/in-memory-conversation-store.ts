import {
  CONVERSATION_DELIVERY_FROM,
  CONVERSATION_ERROR_CODES,
  ConversationService,
  err,
  ok,
  type ConversationMessage,
  type ConversationStore,
} from '@herobids/domain';
import type { ConversationRouteDeps } from '../../routes/conversation-http.js';

/**
 * In-memory ConversationStore with the repository's observable rules: owner check on an existing thread,
 * id idempotency and conflict, the queued-only delivery mark, the failed-or-stale-queued requeue, and the
 * (created_at, id) keyset read. Route unit tests use it with the real ConversationService.
 */
export class InMemoryConversationStore implements ConversationStore {
  readonly owners = new Map<string, string>();
  /** Agent participants of peer conversations, by conversation id. */
  readonly peerAgents = new Map<string, [string, string]>();
  readonly messages: ConversationMessage[] = [];
  failWith: string | null = null;

  async recordUserAgentMessage(input: Parameters<ConversationStore['recordUserAgentMessage']>[0]) {
    return this.record(input);
  }

  async recordPeerMessage(input: Parameters<ConversationStore['recordPeerMessage']>[0]) {
    const recorded = await this.record(input);
    if (recorded.ok && !this.peerAgents.has(input.conversationId)) this.peerAgents.set(input.conversationId, input.agentIds);
    return recorded;
  }

  async listPeerThreads(input: Parameters<ConversationStore['listPeerThreads']>[0]) {
    if (this.failWith) return err({ code: this.failWith, message: 'conversation_store_failed' });
    const threads = [...this.peerAgents.entries()]
      .filter(([conversationId, agentIds]) => this.owners.get(conversationId) === input.ownerUserId && agentIds.includes(input.agentId))
      .map(([conversationId, agentIds]) => ({
        conversationId,
        peerAgentId: agentIds.find((agentId) => agentId !== input.agentId) ?? input.agentId,
        lastMessageAt: this.messages
          .filter((message) => message.conversationId === conversationId)
          .reduce<Date | null>((latest, message) => (latest === null || message.createdAt > latest ? message.createdAt : latest), null),
      }))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
    return ok(threads.slice(0, input.limit));
  }

  private record(input: { conversationId: string; ownerUserId: string; message: Parameters<ConversationStore['recordUserAgentMessage']>[0]['message'] }) {
    if (this.failWith) return err({ code: this.failWith, message: 'conversation_store_failed' });
    const owner = this.owners.get(input.conversationId);
    if (owner !== undefined && owner !== input.ownerUserId) {
      return err({ code: CONVERSATION_ERROR_CODES.ownerMismatch, message: 'conversation_owner_mismatch' });
    }
    const existing = this.messages.find((message) => message.id === input.message.id);
    if (existing) {
      const sameSender = existing.conversationId === input.conversationId
        && existing.senderType === input.message.senderType
        && existing.senderId === input.message.senderId;
      return sameSender
        ? ok({ message: existing, created: false })
        : err({ code: CONVERSATION_ERROR_CODES.messageIdConflict, message: 'conversation_message_id_conflict' });
    }
    this.owners.set(input.conversationId, input.ownerUserId);
    const message: ConversationMessage = {
      ...input.message,
      conversationId: input.conversationId,
      deliveryDetail: input.message.deliveryDetail ?? null,
      providerMessageId: input.message.providerMessageId ?? null,
      queuedAt: input.message.createdAt,
    };
    this.messages.push(message);
    return ok({ message, created: true });
  }

  async markDelivery(input: Parameters<ConversationStore['markDelivery']>[0]) {
    const index = this.messages.findIndex((message) => message.id === input.messageId);
    const current = this.messages[index];
    if (!current) return err({ code: CONVERSATION_ERROR_CODES.messageNotFound, message: 'conversation_message_not_found' });
    if (current.deliveryStatus !== CONVERSATION_DELIVERY_FROM) {
      return err({ code: CONVERSATION_ERROR_CODES.invalidDeliveryTransition, message: 'invalid_delivery_transition' });
    }
    const updated = {
      ...current,
      deliveryStatus: input.status,
      deliveryDetail: input.detail ?? current.deliveryDetail,
      providerMessageId: input.providerMessageId ?? current.providerMessageId,
      channel: input.channel ?? current.channel,
    };
    this.messages[index] = updated;
    return ok(updated);
  }

  async requeueUndeliveredMessage(input: Parameters<ConversationStore['requeueUndeliveredMessage']>[0]) {
    const index = this.messages.findIndex((message) => message.id === input.messageId
      && message.conversationId === input.conversationId
      && this.owners.get(message.conversationId) === input.ownerUserId
      && message.senderType === input.senderType
      && message.senderId === input.senderId
      && (message.deliveryStatus === 'failed'
        || (message.deliveryStatus === 'queued' && message.queuedAt.getTime() <= input.staleBefore.getTime())));
    const current = this.messages[index];
    if (!current) return ok(null);
    const updated = { ...current, deliveryStatus: 'queued' as const, deliveryDetail: null, queuedAt: input.now };
    this.messages[index] = updated;
    return ok(updated);
  }

  async findMessage(input: Parameters<ConversationStore['findMessage']>[0]) {
    if (this.failWith) return err({ code: this.failWith, message: 'conversation_store_failed' });
    const found = this.messages.find((message) => message.id === input.messageId
      && message.conversationId === input.conversationId
      && this.owners.get(message.conversationId) === input.ownerUserId
      && message.senderType === input.senderType
      && message.senderId === input.senderId);
    return ok(found ?? null);
  }

  async listUserAgentThread(input: Parameters<ConversationStore['listUserAgentThread']>[0]) {
    if (this.owners.get(input.conversationId) !== input.ownerUserId) return ok([]);
    const rows = this.messages
      .filter((message) => message.conversationId === input.conversationId)
      .filter((message) => {
        if (!input.before || input.beforeId === null) return true;
        const at = message.createdAt.getTime();
        const cursorAt = input.before.getTime();
        return at < cursorAt || (at === cursorAt && message.id < input.beforeId);
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, input.limit);
    return ok(rows.reverse());
  }
}

export function buildInMemoryConversationDeps(options: { start?: number } = {}): ConversationRouteDeps & { store: InMemoryConversationStore; advanceClock: (ms: number) => void } {
  const store = new InMemoryConversationStore();
  const limits = { userMessageMaxChars: 4000, threadDefaultPageSize: 50, threadMaxPageSize: 200, staleQueuedAfterSeconds: 60 };
  let clock = options.start ?? Date.parse('2026-10-25T10:00:00.000Z');
  let nextId = 0;
  const service = new ConversationService({ store, limits, newId: () => `generated-${++nextId}`, now: () => new Date(clock++) });
  return { service, limits, store, advanceClock: (ms) => { clock += ms; } };
}
