import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * User credentials — encrypted API keys/secrets per venue.
 * User-scoped (one owner). Agents reference these via agent_credentials.
 * Secrets are encrypted at rest. Decrypted just-in-time by the worker.
 */
export const userCredentials = pgTable('user_credentials', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
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
