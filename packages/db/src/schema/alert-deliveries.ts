import { pgTable, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Alert deliveries — tracks each attempt to deliver an event notification
 * to an external channel (Telegram, etc.).
 */
export const alertDeliveries = pgTable('alert_deliveries', {
  id: text('id').primaryKey(),               // UUIDv7
  /** The journal event ID that triggered this alert */
  journalEventId: text('journal_event_id').notNull(),
  /** Channel type: telegram */
  channel: text('channel').notNull(),
  /** Destination identifier (e.g. Telegram chat_id) */
  destination: text('destination').notNull(),
  /** Delivery status: pending | delivered | failed */
  status: text('status').notNull().default('pending'),
  /** Number of delivery attempts made */
  attempts: integer('attempts').notNull().default(0),
  /** Last error message if delivery failed */
  lastError: text('last_error'),
  /** When this delivery was claimed by a worker */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** When the delivery was confirmed */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_alert_deliveries_status').on(t.status),
  index('idx_alert_deliveries_journal_event_id').on(t.journalEventId),
  uniqueIndex('uq_alert_deliveries_event_channel_dest').on(t.journalEventId, t.channel, t.destination),
]);
