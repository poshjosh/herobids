import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { connections } from './connections.js';

/**
 * Trading bindings — family-specific execution targets derived from connections.
 *
 * A binding is user-owned, connection-backed, and reusable across agent grants.
 */
export const tradingBindings = pgTable('trading_bindings', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  connectionId: text('connection_id').notNull()
    .references(() => connections.id, { onDelete: 'restrict' }),
  /** Provider identifier inherited from the source connection */
  provider: text('provider').notNull(),
  /** Human-readable label inherited from or derived from the source connection */
  label: text('label').notNull(),
  /** Provider/account reference from the source venue account when known */
  bindingRef: text('binding_ref'),
  /** active | revoked */
  status: text('status').notNull().default('active'),
  /** Normalized trading capability metadata */
  bindingProfile: jsonb('binding_profile').$type<Record<string, unknown>>(),
  /** Traceability back to the migrated venue_accounts row, when applicable */
  sourceVenueAccountId: text('source_venue_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_trading_bindings_user_id').on(t.userId),
  index('idx_trading_bindings_connection_id').on(t.connectionId),
  index('idx_trading_bindings_provider').on(t.provider),
  index('idx_trading_bindings_status').on(t.status),
  uniqueIndex('uq_trading_bindings_connection_id').on(t.connectionId),
]);