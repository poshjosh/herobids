import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * Credentials — encrypted API keys/secrets per venue.
 * Secrets are encrypted at rest. Decrypted just-in-time by the worker.
 */
export const credentials = pgTable('credentials', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull(),
  venue: text('venue').notNull(),
  /** Display label */
  label: text('label').notNull(),
  /** Encrypted credential blob (API key, secret, passphrase) */
  encryptedData: text('encrypted_data').notNull(),
  /** Encryption metadata (algorithm, key version, etc.) */
  encryptionMeta: jsonb('encryption_meta').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
