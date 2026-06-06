import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { venueAccounts } from './venue-accounts.js';
import { blueprints } from './blueprints.js';

/**
 * Bots — the core execution unit.
 * One bot = one strategy running against one venue account.
 * Blueprint fields (config, venueAccountId) are set at creation.
 * Runtime fields (status, startedAt, stoppedAt) track operational state.
 */
export const bots = pgTable('bots', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  // portfolioId REMOVED — no MVP benefit; user thinks in wallets/accounts
  venueAccountId: text('venue_account_id').notNull()
    .references(() => venueAccounts.id, { onDelete: 'restrict' }),
  // strategyId REMOVED — redundant with config.strategy.type
  /** Bot configuration: strategy params, risk overrides, execution mode.
   *  config.strategy.type is the strategy discriminator. */
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  /** Optional reference to the blueprint this bot was instantiated from */
  blueprintId: text('blueprint_id').references(() => blueprints.id, { onDelete: 'set null' }),
  /** Snapshot of the blueprint configData (merged with any overrides) at bot creation time */
  configSnapshot: jsonb('config_snapshot').$type<Record<string, unknown>>(),
  /** Current status: stopped | running | crashed */
  status: text('status').notNull().default('stopped'),
  // configVersion REMOVED — no consumer; use updatedAt as ETag
  /** Who created this bot: agent | user | system */
  creatorType: text('creator_type').notNull().default('user'),
  /** agentId if creatorType=agent; userId if creatorType=user; null if system */
  creatorId: text('creator_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_bots_user_id').on(t.userId),
  index('idx_bots_status').on(t.status),
  index('idx_bots_creator_id').on(t.creatorId),
  index('idx_bots_venue_account_id').on(t.venueAccountId),
  // uq_trading_instances_active_venue_account REMOVED
  // Replaced by runtime broker check: agents.maxBotsPerVenueAccount (operator config)
]);
