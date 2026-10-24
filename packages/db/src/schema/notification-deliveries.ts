import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { agents } from './agents.js';

export type NotificationDeliveryChannel = 'web_push' | 'email';
export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/**
 * Delivery ledger for out-of-band agent notifications (082 E4).
 * The (event_key, channel) unique key is the duplicate guard: a retry or a second replica cannot send the same
 * email twice. A row is written as 'pending' before the send, so a crash mid-send leaves a visible 'pending' row.
 */
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** Unique per outbound message: `<agentId>:<outboundMessageId>` */
  eventKey: text('event_key').notNull(),
  channel: text('channel').$type<NotificationDeliveryChannel>().notNull(),
  status: text('status').$type<NotificationDeliveryStatus>().notNull(),
  /** Decision reason when recorded as sent; error code when failed. Never message text or addresses. */
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('uq_notification_deliveries_event_channel').on(t.eventKey, t.channel),
  index('idx_notification_deliveries_user_channel_created').on(t.userId, t.channel, t.createdAt),
]);
