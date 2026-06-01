import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Trading instances — the core runtime unit.
 * One trading instance = one strategy running against one portfolio/venue-account pair.
 */
export const tradingInstances = pgTable('trading_instances', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  portfolioId: text('portfolio_id').notNull(),
  venueAccountId: text('venue_account_id').notNull(),
  /** Strategy type identifier */
  strategyId: text('strategy_id').notNull(),
  /** Instance-specific configuration (strategy params, risk overrides, execution mode) */
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  /** Current status */
  status: text('status').notNull().default('stopped'),  // stopped | running | crashed
  /** Config version — incremented on each config change */
  configVersion: integer('config_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_trading_instances_user_id').on(t.userId),
  index('idx_trading_instances_status').on(t.status),
  // Safety invariant: at most one non-stopped instance per venue account
  uniqueIndex('uq_trading_instances_active_venue_account')
    .on(t.venueAccountId)
    .where(sql`${t.status} != 'stopped'`),
]);
