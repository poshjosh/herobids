import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Token safety overrides — one-time, time-bound override tickets that allow
 * an agent or bot to bypass a token safety rejection for a specific token.
 *
 * Overrides are:
 * - scoped to actor, bot, venue account, network, and token address
 * - issued when a safety rejection occurs and operator policy allows it
 * - time-bound (expires after configurable TTL)
 * - one-time use (consumed atomically on first use)
 * - auditable (persisted with full context)
 */
export const tokenSafetyOverrides = pgTable('token_safety_overrides', {
  id: text('id').primaryKey(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  botId: text('bot_id'),
  venueAccountId: text('venue_account_id').notNull(),
  network: text('network').notNull(),
  tokenAddress: text('token_address').notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull(),
  /** Status: active | consumed | expired */
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  /** Identifier of the entity that consumed this override (bot ID, actor ID, or decision ID) */
  consumedBy: text('decision_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_token_safety_overrides_actor').on(t.actorType, t.actorId),
  index('idx_token_safety_overrides_token').on(t.network, t.tokenAddress),
  index('idx_token_safety_overrides_status').on(t.status),
]);
