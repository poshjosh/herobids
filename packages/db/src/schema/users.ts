import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Users — authenticated user accounts.
 * Created on first OAuth login; no separate signup flow.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),               // UUIDv7
  /** Display name (from OAuth profile) */
  displayName: text('display_name').notNull(),
  /** Email (from OAuth profile, unique per user) */
  email: text('email').notNull().unique(),
  /** URL to profile picture (optional) */
  avatarUrl: text('avatar_url'),
  /** Plan ID — references plans config section */
  planId: text('plan_id').notNull().default('free'),
  /** Telegram chat ID for direct user messaging (optional, user-provided) */
  telegramChatId: text('telegram_chat_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
