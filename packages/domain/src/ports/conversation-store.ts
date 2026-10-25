import type { Result } from '../result.js';
import type {
  ConversationChannel,
  ConversationDeliveryStatus,
  ConversationDeliveryTarget,
  ConversationError,
  ConversationMessage,
  ConversationSenderType,
  PeerThreadSummary,
  RecordedConversationMessage,
  UserAgentChannel,
} from '../conversations/conversation.js';

export interface NewConversationMessage {
  id: string;
  senderType: ConversationSenderType;
  senderId: string | null;
  channel: ConversationChannel;
  subject: string | null;
  body: string;
  messageClass: string | null;
  deliveryStatus: ConversationDeliveryStatus;
  /** Set only when the row is recorded with its final outcome (a mirrored delivery); omitted means null. */
  deliveryDetail?: string | null;
  providerMessageId?: string | null;
  createdAt: Date;
}

export interface RecordUserAgentMessageInput {
  conversationId: string;
  ownerUserId: string;
  agentId: string;
  message: NewConversationMessage;
}

export interface RecordPeerConversationMessageInput {
  /** `peerConversationId(agentIds)`. */
  conversationId: string;
  /** `peerKey(agentIds)`. */
  peerKey: string;
  ownerUserId: string;
  /** The two agents of the pair, in any order. */
  agentIds: [string, string];
  message: NewConversationMessage;
}

export interface ListPeerConversationsInput {
  ownerUserId: string;
  agentId: string;
  limit: number;
}

export interface MarkConversationDeliveryInput {
  messageId: string;
  status: ConversationDeliveryTarget;
  /** Null leaves the stored value unchanged. */
  detail: string | null;
  /** Null leaves the stored value unchanged. */
  providerMessageId: string | null;
  /** Null leaves the stored channel unchanged. */
  channel: UserAgentChannel | null;
}

export interface RequeueUndeliveredMessageInput {
  messageId: string;
  conversationId: string;
  ownerUserId: string;
  /** The author of the message: the user, or the creator agent that wrote to its child. */
  senderType: Extract<ConversationSenderType, 'user' | 'agent'>;
  senderId: string;
  /** Becomes the row's `queuedAt`. */
  now: Date;
  /** A `queued` row with `queuedAt` at or before this is stuck and claimable. */
  staleBefore: Date;
}

export interface FindConversationMessageInput {
  messageId: string;
  conversationId: string;
  ownerUserId: string;
  senderType: ConversationSenderType;
  senderId: string | null;
}

export interface ListUserAgentThreadInput {
  conversationId: string;
  ownerUserId: string;
  limit: number;
  /**
   * Keyset cursor: only rows ordered before (`before`, `beforeId`) by (created_at, id). Both are the values of the
   * oldest row of the previous page. Both null reads the newest rows; one without the other is invalid.
   */
  before: Date | null;
  beforeId: string | null;
}

/**
 * Persistence port for conversations. Only ConversationService calls it.
 *
 * Authorization is the caller's job: the store checks that an existing conversation belongs to `ownerUserId`,
 * but it never checks that `agentId` belongs to that user. The caller must verify the agent is owned by
 * `ownerUserId` before recording (the P2 route must answer 404 for another user's agent).
 */
export interface ConversationStore {
  /**
   * Creates the user-agent conversation and its two participants on first use, then inserts the message and
   * moves `last_message_at`. A repeated message id in the same conversation returns the stored row with
   * `created: false`. An id used in another conversation, or by another sender, is refused.
   */
  recordUserAgentMessage(input: RecordUserAgentMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>>;
  /**
   * Creates the agent-agent conversation (one per pair, by `peer_key`) and its two agent participants on first
   * use, then inserts the message and moves `last_message_at`. Same id and owner rules as `recordUserAgentMessage`.
   * The caller must verify that both agents belong to `ownerUserId`.
   */
  recordPeerMessage(input: RecordPeerConversationMessageInput): Promise<Result<RecordedConversationMessage, ConversationError>>;
  /**
   * The owner's peer threads that include `agentId`, newest message first, in two queries (the conversations, then
   * the participants of all of them), whatever the page size.
   */
  listPeerThreads(input: ListPeerConversationsInput): Promise<Result<PeerThreadSummary[], ConversationError>>;
  /**
   * Moves a `queued` message to `sent`, `failed` or `refused` in one conditional update; supplied fields are
   * merged, omitted ones are kept. A message in any other state is refused with
   * `conversation.invalid_delivery_transition`; an unknown id with `conversation.message_not_found`.
   *
   * Delivery workers only. A repeated mark is an invalid transition, not a silent success, so a worker that
   * retries after a crash must treat `conversation.invalid_delivery_transition` as "already marked".
   */
  markDelivery(input: MarkConversationDeliveryInput): Promise<Result<ConversationMessage, ConversationError>>;
  /**
   * The one way back to `queued`: the sender's own `failed` message, or its `queued` message that has been stuck
   * since `staleBefore`, so a retry with the same id can publish again (002 D5, D6). The claim stamps `queuedAt`
   * with `now`, so exactly one of several concurrent callers receives the row. Null when the message is not
   * claimable (absent, another sender's, or in any other state).
   */
  requeueUndeliveredMessage(input: RequeueUndeliveredMessageInput): Promise<Result<ConversationMessage | null, ConversationError>>;
  /** The sender's own message by id in the owner's conversation; null when there is none (another sender's or owner's rows are not read). */
  findMessage(input: FindConversationMessageInput): Promise<Result<ConversationMessage | null, ConversationError>>;
  /**
   * Newest `limit` rows before the (created_at, id) cursor, in ascending order, in one query. Empty when the owner has
   * no such thread. Reads any conversation by id, so it serves peer threads too.
   */
  listUserAgentThread(input: ListUserAgentThreadInput): Promise<Result<ConversationMessage[], ConversationError>>;
}
