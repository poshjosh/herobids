import { pgTable, text, timestamp, jsonb, index, foreignKey } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { userCredentials } from './user-credentials.js';
import { venueAccounts } from './venue-accounts.js';

/**
 * Connections — user-owned platform resources representing a usable external
 * linkage to a provider or system.
 *
 * Connections are the single entity for provider linkage. They absorb the
 * former trading_bindings table. Capability grants (trading, automation,
 * messaging, etc.) are scoped directly to connections.
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
  /** Absorbed from trading_bindings: account/wallet reference at the provider */
  providerRef: text('provider_ref'),
  /** Absorbed from trading_bindings: normalized capability metadata */
  profile: jsonb('profile').$type<Record<string, unknown>>(),
  /** Resolved FK to venue_accounts — set when the connection maps to a known venue account.
   *  null for non-trading connections (e.g. telegram, twitter). */
  resolvedVenueAccountId: text('resolved_venue_account_id'),
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
  foreignKey({ columns: [t.resolvedVenueAccountId], foreignColumns: [venueAccounts.id] }).onDelete('set null'),
]);
