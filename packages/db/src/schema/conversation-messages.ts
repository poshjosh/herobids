import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import type {
  ConversationChannel,
  ConversationDeliveryStatus,
  ConversationSenderType,
} from '@herobids/domain';
import { conversations } from './conversations.js';

/**
 * Every message of a conversation, on any channel (002 section 4.2, schema note 2.3).
 * The id equals the client message id or the envelope message id, so a retry is detected by the same id.
 */
export const conversationMessages = pgTable('conversation_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  /** user | agent | platform */
  senderType: text('sender_type').$type<ConversationSenderType>().notNull(),
  /** User or agent id; null for platform */
  senderId: text('sender_id'),
  /** web | telegram | internal */
  channel: text('channel').$type<ConversationChannel>().notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  /** alert | reminder | routine, as sent by the agent */
  messageClass: text('message_class'),
  /** queued | sent | failed | not_applicable | refused */
  deliveryStatus: text('delivery_status').$type<ConversationDeliveryStatus>().notNull(),
  /** Failure text; for refused, a dot-string reason code such as peer.rate_limited */
  deliveryDetail: text('delivery_detail'),
  /** Id returned by the channel when it sent the message */
  providerMessageId: text('provider_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the row last entered `queued`: set to created_at on insert, restamped by a retry claim. Ages a stuck queued row. */
  queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_conversation_messages_conversation_created').on(t.conversationId, t.createdAt),
  // Reply correlation (DEC-51): finds the message a Telegram reply points at. Non-unique: a provider message id is unique only within one chat.
  index('idx_conversation_messages_provider_message').on(t.channel, t.providerMessageId).where(sql`${t.providerMessageId} is not null`),
]);
