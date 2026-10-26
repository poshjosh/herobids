import type { DomainError } from '../result.js';

export const CONVERSATION_KINDS = ['user_agent', 'agent_agent'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_SENDER_TYPES = ['user', 'agent', 'platform'] as const;
export type ConversationSenderType = (typeof CONVERSATION_SENDER_TYPES)[number];

/** `internal` is for peer messages, which have no provider (schema note S-3). */
export const CONVERSATION_CHANNELS = ['web', 'telegram', 'internal'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/** Channels of a user-agent thread. `internal` is reserved for peer threads. */
export type UserAgentChannel = Exclude<ConversationChannel, 'internal'>;

/** True when a provider name (a delivery result's provider) is a channel the user-agent thread has. */
export function isUserAgentChannel(provider: string): provider is UserAgentChannel {
  return provider !== 'internal' && (CONVERSATION_CHANNELS as readonly string[]).includes(provider);
}

export const CONVERSATION_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'not_applicable', 'refused'] as const;
export type ConversationDeliveryStatus = (typeof CONVERSATION_DELIVERY_STATUSES)[number];

/**
 * Delivery state machine. Only a `queued` row may be marked, and only to one of these targets.
 * `sent`, `failed`, `refused` and `not_applicable` are final for `markDelivery`; only a retry claim (requeueUndeliveredMessage)
 * returns a row to `queued`. `not_applicable` is a message that had nowhere to go (no chat address, no chat channel):
 * the thread itself is its delivery.
 */
export const CONVERSATION_DELIVERY_FROM = 'queued' satisfies ConversationDeliveryStatus;
export const CONVERSATION_DELIVERY_TARGETS = ['sent', 'failed', 'refused', 'not_applicable'] as const satisfies readonly ConversationDeliveryStatus[];
export type ConversationDeliveryTarget = (typeof CONVERSATION_DELIVERY_TARGETS)[number];

/**
 * Why a receiving agent dropped a peer message at its stop-switch check (DEC-56, DEC-57 c). Stored as the `refused` row's
 * detail: `paused` when the owner's switch was on, `paused_check_failed` when the switch could not be read (fail closed).
 */
export const PEER_DROP_DETAILS = ['paused', 'paused_check_failed'] as const;
export type PeerDropDetail = (typeof PEER_DROP_DETAILS)[number];

export const CONVERSATION_ERROR_CODES = {
  invalidMessage: 'conversation.invalid_message',
  invalidCursor: 'conversation.invalid_cursor',
  invalidDeliveryTransition: 'conversation.invalid_delivery_transition',
  bodyTooLong: 'conversation.body_too_long',
  ownerMismatch: 'conversation.owner_mismatch',
  messageIdConflict: 'conversation.message_id_conflict',
  messageNotFound: 'conversation.message_not_found',
  storeFailed: 'conversation.store_failed',
} as const;

export type ConversationError = DomainError;

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderType: ConversationSenderType;
  senderId: string | null;
  channel: ConversationChannel;
  subject: string | null;
  body: string;
  messageClass: string | null;
  deliveryStatus: ConversationDeliveryStatus;
  deliveryDetail: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  /** When the row last entered `queued`: its creation, or the last retry claim. Ages a stuck `queued` row. */
  queuedAt: Date;
}

export interface RecordedConversationMessage {
  message: ConversationMessage;
  /** False when the id already existed: a retry. The caller must not publish the message again. */
  created: boolean;
}

/** Operator-configured limits (messaging.conversations.*). */
export interface ConversationLimits {
  userMessageMaxChars: number;
  threadDefaultPageSize: number;
  threadMaxPageSize: number;
  /** A `queued` row older than this (seconds) is presumed never published and may be re-published by a retry. */
  staleQueuedAfterSeconds: number;
}

/** One user-agent conversation per agent. The id is derived, so concurrent first writes cannot create two. */
export function userAgentConversationId(agentId: string): string {
  return `user_agent:${agentId}`;
}

/** The two agent ids of a peer thread, sorted and joined with `:`. One thread per pair, whichever agent writes first. */
export function peerKey(agentA: string, agentB: string): string {
  return [agentA, agentB].sort().join(':');
}

/** One agent-agent conversation per agent pair. The id is derived, so concurrent first writes cannot create two. */
export function peerConversationId(agentA: string, agentB: string): string {
  return `agent_agent:${peerKey(agentA, agentB)}`;
}

/** One row of the owner's list of peer threads for an agent. */
export interface PeerThreadSummary {
  conversationId: string;
  /** The participant of the thread that is not the agent the list was asked for. */
  peerAgentId: string;
  lastMessageAt: Date | null;
}
