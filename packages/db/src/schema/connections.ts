import { pgTable, text, timestamp, jsonb, index, foreignKey } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { userCredentials } from './user-credentials.js';

/**
 * Connections — user-owned platform resources representing a usable external
 * linkage to a provider or system.
 *
 * Connections are capability-agnostic. Capability families derive family-
 * specific bindings from connections (e.g. a trading account is a trading
 * binding derived from a Hyperliquid connection).
 *
 * A connection may reference a credential for secret-based providers, or
 * leave credentialId null for OAuth-based linkages.
 */
export const connections = pgTable('connections', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  /** FK to user_credentials; null for OAuth-based connections */
  credentialId: text('credential_id'),
  /** Provider identifier: "hyperliquid", "bybit", "telegram", "twitter", etc. */
  provider: text('provider').notNull(),
  /** Human-readable label */
  label: text('label').notNull(),
  /** active | revoked */
  status: text('status').notNull().default('active'),
  /** Provider-specific cached metadata — never contains raw secrets */
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_connections_user_id').on(t.userId),
  index('idx_connections_provider').on(t.provider),
  index('idx_connections_status').on(t.status),
  // SET NULL allows a credential to be deleted even when revoked connection rows still
  // reference it. Active-connection blocking is enforced at the application layer.
  foreignKey({ columns: [t.credentialId], foreignColumns: [userCredentials.id] }).onDelete('set null'),
]);
