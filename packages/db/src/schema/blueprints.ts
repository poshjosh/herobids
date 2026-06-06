import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Blueprints — reusable strategy configuration templates.
 * A blueprint captures a named, versioned set of strategy params, risk overrides,
 * and execution mode. Bots are instantiated from a blueprint reference, storing a
 * snapshot of the config at creation time for audit.
 */
export const blueprints = pgTable('blueprints', {
  id: text('id').primaryKey(),               // UUIDv7
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  description: text('description'),
  /** Full strategy/risk/execution configuration */
  configData: jsonb('config_data').notNull().$type<Record<string, unknown>>(),
  /** Incremented on every PUT so callers can detect stale references */
  configVersion: integer('config_version').notNull().default(1),
  /** Visibility: private (owner only) | public (any authenticated user can read) */
  visibility: text('visibility').notNull().default('private'),
  /** Optional preset key this blueprint was derived from (e.g. 'momentum') */
  strategyPreset: text('strategy_preset'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_blueprints_user_id').on(t.userId),
  index('idx_blueprints_visibility').on(t.visibility),
]);
