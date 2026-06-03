import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Billing webhook events — idempotency/dedupe table for Stripe webhook delivery.
 * Keyed by Stripe event ID to prevent duplicate processing.
 */
export const billingWebhookEvents = pgTable(
  'billing_webhook_events',
  {
    /** Stripe event ID (e.g. evt_...) */
    id: text('id').primaryKey(),
    /** Stripe event type (e.g. customer.subscription.updated) */
    eventType: text('event_type').notNull(),
    /** Processing status: processed | failed */
    status: text('status').notNull().default('processed'),
    /** Error message if processing failed */
    error: text('error'),
    /** When the event was received and processed */
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_billing_webhook_events_event_type').on(t.eventType),
  ],
);
