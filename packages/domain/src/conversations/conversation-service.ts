import { err, type Result } from '../result.js';
import type { ConversationStore } from '../ports/conversation-store.js';
import {
  CONVERSATION_CHANNELS,
  CONVERSATION_DELIVERY_STATUSES,
  CONVERSATION_DELIVERY_TARGETS,
  CONVERSATION_ERROR_CODES,
  userAgentConversationId,
  type ConversationDeliveryTarget,
  type ConversationDeliveryStatus,
  type ConversationError,
  type ConversationLimits,
  type ConversationMessage,
  type RecordedConversationMessage,
  type UserAgentChannel,
} from './conversation.js';

export interface RecordUserMessageInput {
  /** Client-generated id. A repeat of the same id is a retry and returns the stored row. */
  id?: string;
  ownerUserId: string;
  agentId: string;
  channel: UserAgentChannel;
  body: string;
}

export interface RecordAgentMessageInput {
  id?: string;
  ownerUserId: string;
  /** The agent whose conversation the message belongs to. */
  agentId: string;
  /** The authoring agent. Defaults to `agentId`; differs when a creator agent writes to its child. */
  senderAgentId?: string;
  channel: UserAgentChannel;
  subject?: string | null;
  body: string;
  messageClass?: string | null;
  deliveryStatus?: ConversationDeliveryStatus;
  /** Failure text or reason of an already-final delivery. */
  deliveryDetail?: string | null;
  /** Id the channel returned for an already-sent message. */
  providerMessageId?: string | null;
}

export interface RecordPlatformMessageInput {
  id?: string;
  ownerUserId: string;
  agentId: string;
  channel: UserAgentChannel;
  subject?: string | null;
  body: string;
  messageClass?: string | null;
  deliveryStatus?: ConversationDeliveryStatus;
  /** Failure text or reason of an already-final delivery. */
  deliveryDetail?: string | null;
  /** Id the channel returned for an already-sent message. */
  providerMessageId?: string | null;
}

export interface MarkDeliveryInput {
  messageId: string;
  status: ConversationDeliveryStatus;
  detail?: string | null;
  providerMessageId?: string | null;
  /** The channel that carried the message, when it differs from the one it was recorded on (set with `sent`). */
  channel?: UserAgentChannel;
}

/** Who wrote the message being retried: the owner, or the creator agent that wrote to its child. */
export type MessageSender = { type: 'user' } | { type: 'agent'; agentId: string };

export interface MessageLookupInput {
  ownerUserId: string;
  agentId: string;
  messageId: string;
  sender: MessageSender;
}

export interface ListThreadInput {
  ownerUserId: string;
  agentId: string;
  limit?: number;
  /** Cursor: `createdAt` and `id` of the oldest row of the previous page. Pass both or neither. */
  before?: Date;
  beforeId?: string;
}

export interface ConversationServiceDeps {
  store: ConversationStore;
  limits: ConversationLimits;
  newId: () => string;
  now: () => Date;
}

function isDeliveryTarget(status: string): status is ConversationDeliveryTarget {
  return (CONVERSATION_DELIVERY_TARGETS as readonly string[]).includes(status);
}

function invalid(code: string, message: string, context?: Record<string, unknown>): Result<never, ConversationError> {
  return err(context ? { code, message, context } : { code, message });
}

/**
 * The only writer of conversation rows. Validates input and delegates persistence to the store port.
 * Ids come from the caller or `newId`; timestamps come from `now`, so rows carry millisecond times
 * and survive the round trip through a JS `Date` cursor. The cursor is the pair (`before`, `beforeId`),
 * so rows that share a timestamp are neither skipped nor repeated.
 *
 * Authorization is the caller's job: this service trusts that `agentId` belongs to `ownerUserId`. Callers
 * (the P2 route) must verify that before recording and answer 404 for another user's agent. Only an
 * existing conversation's owner is checked here.
 */
export class ConversationService {
  private readonly store: ConversationStore;
  private readonly limits: ConversationLimits;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(deps: ConversationServiceDeps) {
    this.store = deps.store;
    this.limits = deps.limits;
    this.newId = deps.newId;
    this.now = deps.now;
  }

  async recordUserMessage(input: RecordUserMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const checked = this.checkBody(input.body, this.limits.userMessageMaxChars)
      ?? this.checkIdentity(input.ownerUserId, input.agentId)
      ?? this.checkChannel(input.channel)
      ?? this.checkOptionalId(input.id);
    if (checked) return checked;
    return this.store.recordUserAgentMessage({
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      message: {
        id: input.id ?? this.newId(),
        senderType: 'user',
        senderId: input.ownerUserId,
        channel: input.channel,
        subject: null,
        body: input.body,
        messageClass: null,
        deliveryStatus: 'queued',
        createdAt: this.now(),
      },
    });
  }

  async recordAgentMessage(input: RecordAgentMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const checked = this.checkBody(input.body, null)
      ?? this.checkIdentity(input.ownerUserId, input.agentId)
      ?? this.checkChannel(input.channel)
      ?? this.checkDeliveryStatus(input.deliveryStatus)
      ?? this.checkOptionalId(input.id);
    if (checked) return checked;
    return this.store.recordUserAgentMessage({
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      message: {
        id: input.id ?? this.newId(),
        senderType: 'agent',
        senderId: input.senderAgentId ?? input.agentId,
        channel: input.channel,
        subject: input.subject ?? null,
        body: input.body,
        messageClass: input.messageClass ?? null,
        deliveryStatus: input.deliveryStatus ?? 'queued',
        ...(input.deliveryDetail !== undefined ? { deliveryDetail: input.deliveryDetail } : {}),
        ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
        createdAt: this.now(),
      },
    });
  }

  async recordPlatformMessage(input: RecordPlatformMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>> {
    const checked = this.checkBody(input.body, null)
      ?? this.checkIdentity(input.ownerUserId, input.agentId)
      ?? this.checkChannel(input.channel)
      ?? this.checkDeliveryStatus(input.deliveryStatus)
      ?? this.checkOptionalId(input.id);
    if (checked) return checked;
    return this.store.recordUserAgentMessage({
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      message: {
        id: input.id ?? this.newId(),
        senderType: 'platform',
        senderId: null,
        channel: input.channel,
        subject: input.subject ?? null,
        body: input.body,
        messageClass: input.messageClass ?? null,
        deliveryStatus: input.deliveryStatus ?? 'queued',
        ...(input.deliveryDetail !== undefined ? { deliveryDetail: input.deliveryDetail } : {}),
        ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
        createdAt: this.now(),
      },
    });
  }

  /**
   * Delivery workers only. A repeated mark returns `conversation.invalid_delivery_transition`; a worker that
   * retries after a crash must treat that code as "already marked", not as a failure.
   */
  async markDelivery(input: MarkDeliveryInput): Promise<Result<ConversationMessage, ConversationError>> {
    if (input.messageId.trim() === '') {
      return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'message_id_required');
    }
    const badStatus = this.checkDeliveryStatus(input.status);
    if (badStatus) return badStatus;
    if (!isDeliveryTarget(input.status)) {
      return invalid(CONVERSATION_ERROR_CODES.invalidDeliveryTransition, 'invalid_delivery_transition', { to: input.status });
    }
    if (input.channel !== undefined) {
      const badChannel = this.checkChannel(input.channel);
      if (badChannel) return badChannel;
    }
    return this.store.markDelivery({
      messageId: input.messageId,
      status: input.status,
      detail: input.detail ?? null,
      providerMessageId: input.providerMessageId ?? null,
      channel: input.channel ?? null,
    });
  }

  /**
   * True when a retry may publish the message again: it failed, or it has been `queued` for longer than
   * `staleQueuedAfterSeconds` (the process died before publishing, or the status write failed).
   */
  needsRepublish(message: Pick<ConversationMessage, 'deliveryStatus' | 'queuedAt'>): boolean {
    return message.deliveryStatus === 'failed' || this.isStuckQueued(message);
  }

  isStuckQueued(message: Pick<ConversationMessage, 'deliveryStatus' | 'queuedAt'>): boolean {
    return message.deliveryStatus === 'queued' && message.queuedAt.getTime() <= this.staleBefore().getTime();
  }

  /** The sender's own message by id; null when absent. Another sender's or owner's row reads as absent. */
  async findMessage(input: MessageLookupInput): Promise<Result<ConversationMessage | null, ConversationError>> {
    const checked = this.checkIdentity(input.ownerUserId, input.agentId) ?? this.checkOptionalId(input.messageId);
    if (checked) return checked;
    return this.store.findMessage({
      messageId: input.messageId,
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      ...this.senderOf(input),
    });
  }

  /**
   * Moves the sender's own failed (or stuck `queued`) message back to `queued` so the caller can publish it
   * again. Null when there is nothing to retry (the message is in another state, or another retry claimed it
   * first); the caller must not publish.
   */
  async retryUndeliveredMessage(input: MessageLookupInput): Promise<Result<ConversationMessage | null, ConversationError>> {
    const checked = this.checkIdentity(input.ownerUserId, input.agentId) ?? this.checkOptionalId(input.messageId);
    if (checked) return checked;
    const now = this.now();
    return this.store.requeueUndeliveredMessage({
      messageId: input.messageId,
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      ...this.senderOf(input),
      now,
      staleBefore: this.staleBefore(now),
    });
  }

  /** Newest `limit` rows before the cursor, oldest first. A thread that does not exist reads as empty. */
  async listThread(input: ListThreadInput): Promise<Result<ConversationMessage[], ConversationError>> {
    const checked = this.checkIdentity(input.ownerUserId, input.agentId);
    if (checked) return checked;
    const requested = input.limit ?? this.limits.threadDefaultPageSize;
    if (!Number.isInteger(requested) || requested < 1) {
      return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'invalid_limit');
    }
    const hasBefore = input.before !== undefined;
    const hasBeforeId = input.beforeId !== undefined;
    if (
      hasBefore !== hasBeforeId
      || (input.before !== undefined && Number.isNaN(input.before.getTime()))
      || (input.beforeId !== undefined && input.beforeId.trim() === '')
    ) {
      return invalid(CONVERSATION_ERROR_CODES.invalidCursor, 'invalid_cursor');
    }
    return this.store.listUserAgentThread({
      conversationId: userAgentConversationId(input.agentId),
      ownerUserId: input.ownerUserId,
      limit: Math.min(requested, this.limits.threadMaxPageSize),
      before: input.before ?? null,
      beforeId: input.beforeId ?? null,
    });
  }

  private staleBefore(now: Date = this.now()): Date {
    return new Date(now.getTime() - this.limits.staleQueuedAfterSeconds * 1000);
  }

  private senderOf(input: MessageLookupInput): { senderType: 'user' | 'agent'; senderId: string } {
    return input.sender.type === 'user'
      ? { senderType: 'user', senderId: input.ownerUserId }
      : { senderType: 'agent', senderId: input.sender.agentId };
  }

  private checkBody(body: string, maxChars: number | null): Result<never, ConversationError> | null {
    if (body.trim() === '') return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'body_required');
    if (maxChars !== null && body.length > maxChars) {
      return invalid(CONVERSATION_ERROR_CODES.bodyTooLong, 'body_too_long', { maxChars });
    }
    return null;
  }

  private checkIdentity(ownerUserId: string, agentId: string): Result<never, ConversationError> | null {
    if (ownerUserId.trim() === '' || agentId.trim() === '') {
      return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'owner_and_agent_required');
    }
    return null;
  }

  // Types are compile-time only; these guard values that arrive from JSON or an untyped caller.
  // `internal` is a valid channel but belongs to peer threads, so it is refused here.
  private checkChannel(channel: string): Result<never, ConversationError> | null {
    if (!(CONVERSATION_CHANNELS as readonly string[]).includes(channel) || channel === 'internal') {
      return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'invalid_channel');
    }
    return null;
  }

  private checkDeliveryStatus(status: string | undefined): Result<never, ConversationError> | null {
    if (status !== undefined && !(CONVERSATION_DELIVERY_STATUSES as readonly string[]).includes(status)) {
      return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'invalid_delivery_status');
    }
    return null;
  }

  private checkOptionalId(id: string | undefined): Result<never, ConversationError> | null {
    if (id !== undefined && id.trim() === '') return invalid(CONVERSATION_ERROR_CODES.invalidMessage, 'invalid_message_id');
    return null;
  }
}
