import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

/**
 * Agent outbound messages — persists the actual content of messages sent to users.
 *
 * Covers two authorship paths:
 *  - 'agent': initiated by the agent runtime via the brokered send_message tool
 *  - 'platform': initiated by the platform as a mandatory safety alert
 *
 * This is the source for the UI message feed and authorship-separated audit trail.
 * Telegram delivery status and destination are included for traceability.
 */
export const agentOutboundMessages = pgTable('agent_outbound_messages', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  /** Runtime session that produced this message (null for platform-authored) */
  sessionId: text('session_id'),
  /** Who authored this message: 'agent' | 'platform' */
  authoredBy: text('authored_by').notNull(),
  /** Short subject or category hint (e.g. 'update', 'alert', 'safety') */
  subject: text('subject'),
  /** Actual message body (bounded at application layer) */
  body: text('body').notNull(),
  /** Optional reference to a decision or context hash */
  contextRef: text('context_ref'),
  /** Telegram delivery status: pending | sent | failed */
  deliveryStatus: text('delivery_status').notNull().default('pending'),
  /** Telegram message_id returned on successful send */
  telegramMessageId: text('telegram_message_id'),
  /** Telegram chat ID the message was sent to */
  telegramChatId: text('telegram_chat_id'),
  /** Error detail if delivery failed */
  deliveryError: text('delivery_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_outbound_messages_agent_id').on(t.agentId),
  index('idx_agent_outbound_messages_authored_by').on(t.authoredBy),
  index('idx_agent_outbound_messages_created_at').on(t.createdAt),
  index('idx_agent_outbound_messages_session_id').on(t.sessionId),
]);
