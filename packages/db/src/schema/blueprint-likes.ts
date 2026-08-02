import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { blueprints } from './blueprints.js';
import { users } from './users.js';

/**
 * Tracks user likes on blueprints — one row per user per blueprint.
 */
export const blueprintLikes = pgTable('blueprint_likes', {
  blueprintId: text('blueprint_id').notNull().references(() => blueprints.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_blueprint_likes').on(t.blueprintId, t.userId),
]);
