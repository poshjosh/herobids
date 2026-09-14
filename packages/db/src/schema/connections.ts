import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Connections — user-owned platform resources representing a usable external
 * linkage to a provider or system.
 *
 * Connections are the single entity for provider linkage.
 *
 * A connection may reference a credential for secret-based providers, or
 * leave credentialId null for OAuth-based linkages.
 */
export const connections = pgTable('connections', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  /**
   * Soft reference to a credential. For herobids-owned (non-trading) links this
   * names a local `platform_credentials` row; for trading links it is null — the
   * credential lives behind the Traderton boundary (decision-13 soft-reference
   * pattern). No FK: the boundary owns credential/venue-account lifecycle, so a
   * hard constraint into a Traderton-owned table would be invalid.
   */
  credentialId: text('credential_id'),
  /** Provider identifier: "hyperliquid", "bybit", "telegram", "twitter", etc. */
  provider: text('provider').notNull(),
  /** Human-readable label */
  label: text('label').notNull(),
  /** active | revoked */
  status: text('status').notNull().default('active'),
  /** Account/wallet reference at the provider */
  providerRef: text('provider_ref'),
  /** Normalized capability metadata */
  profile: jsonb('profile').$type<Record<string, unknown>>(),
  /**
   * Soft reference to the boundary-owned venue account backing this trading
   * connection. Null for non-trading connections (e.g. telegram, twitter). No
   * FK — Traderton owns `venue_accounts` (decision-13 soft-reference pattern).
   */
  resolvedVenueAccountId: text('resolved_venue_account_id'),
  /** Provider-specific cached metadata — never contains raw secrets */
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_connections_user_id').on(t.userId),
  index('idx_connections_provider').on(t.provider),
  index('idx_connections_status').on(t.status),
]);
