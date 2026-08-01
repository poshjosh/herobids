import { pgTable, text, varchar, timestamp, jsonb, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { blueprints } from './blueprints.js';
import { users } from './users.js';

/**
 * Immutable revisions for blueprints.
 * Each edit writes a new revision row instead of mutating previous content.
 * The blueprint row's currentRevisionId points to the latest revision.
 */
export const blueprintRevisions = pgTable('blueprint_revisions', {
  id: text('id').primaryKey(),
  blueprintId: text('blueprint_id').notNull().references(() => blueprints.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),

  // Immutable query facets (derived from payload in creation transaction)
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  strategyType: text('strategy_type'),
  style: varchar('style', { length: 16 }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  venueType: text('venue_type'),

  // The strict agent/bot union payload
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),

  changeSummary: text('change_summary'),
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_blueprint_revisions_blueprint_version').on(t.blueprintId, t.version),
  uniqueIndex('uq_blueprint_revisions_blueprint_id').on(t.blueprintId, t.id),
  index('idx_blueprint_revisions_blueprint_created').on(t.blueprintId, t.createdAt),
]);
