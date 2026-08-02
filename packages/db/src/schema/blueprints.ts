import { pgTable, text, varchar, timestamp, integer, index, doublePrecision, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Blueprints — reusable agent/bot configuration templates for the marketplace.
 * Immutable revisions are stored in blueprint_revisions; this table holds the
 * catalog entry with lifecycle state, scores, and current/published pointers.
 */
export const blueprints = pgTable('blueprints', {
  // Identity
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  // Lifecycle
  publicationStatus: text('publication_status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  delistedAt: timestamp('delisted_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),

  // Authoring/public pointers
  currentRevisionId: text('current_revision_id'),
  publishedRevisionId: text('published_revision_id'),

  // Current-revision facets (derived from currentRevisionId transactionally)
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  strategyType: text('strategy_type'),
  style: varchar('style', { length: 16 }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  venueType: text('venue_type'),

  // Lineage
  sourceBlueprintId: text('source_blueprint_id').references((): AnyPgColumn => blueprints.id, { onDelete: 'restrict' }),
  sourceBlueprintRevisionId: text('source_blueprint_revision_id'),

  // Counters/scores
  likeCount: integer('like_count').notNull().default(0),
  forkCount: integer('fork_count').notNull().default(0),
  popularityScore: doublePrecision('popularity_score').notNull().default(0),
  trendingScore: doublePrecision('trending_score').notNull().default(0),
}, (t) => [
  index('idx_blueprints_author_id').on(t.authorId),
  index('idx_blueprints_publication_status').on(t.publicationStatus),
  index('idx_blueprints_kind').on(t.kind),
  index('idx_blueprints_popularity').on(t.popularityScore),
  index('idx_blueprints_trending').on(t.trendingScore),
  index('idx_blueprints_published_at').on(t.publishedAt),
]);
