import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Platform credentials — encrypted NON-TRADING secrets per provider
 * (Gmail/OAuth, social, etc.). User-scoped (one owner). Secrets are encrypted
 * at rest and decrypted just-in-time.
 *
 * Split out of `user_credentials` (D1-cred): trading venue credentials moved
 * behind the Traderton boundary, so herobids stores only the platform
 * (non-trading) half here. Mirrors the `user_credentials` shape exactly.
 */
export const platformCredentials = pgTable('platform_credentials', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  provider: text('provider').notNull(),
  /** Display label */
  label: text('label').notNull(),
  /** Encrypted credential blob (OAuth tokens, API key, secret) */
  encryptedData: text('encrypted_data').notNull(),
  /** Encryption metadata (algorithm, key version, etc.) */
  encryptionMeta: jsonb('encryption_meta').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
