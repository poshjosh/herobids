import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

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
  /** Preferred UI locale selected by the user */
  preferredLocale: text('preferred_locale'),
  /** Telegram chat ID for direct user messaging (optional, user-provided) */
  telegramChatId: text('telegram_chat_id'),
  /** AI model preference chain: { primary, fallback1, fallback2 } each { provider, model } */
  aiModelConfig: jsonb('ai_model_config').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
