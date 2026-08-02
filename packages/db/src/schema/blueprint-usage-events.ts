import { pgTable, text, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Tracks blueprint usage events: instance creation and fork creation.
 * Used for popularity scoring and usage analytics.
 * Composite FK to blueprint_revisions(blueprint_id, id) is added in migration SQL.
 */
export const blueprintUsageEvents = pgTable('blueprint_usage_events', {
  id: text('id').primaryKey(),
  blueprintId: text('blueprint_id').notNull(),
  blueprintRevisionId: text('blueprint_revision_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  subjectKind: text('subject_kind').notNull(), // 'agent', 'bot', or 'blueprint'
  subjectId: text('subject_id').notNull(),
  eventType: text('event_type').notNull(), // 'instance_created' or 'fork_created'
  isSelfUsage: boolean('is_self_usage').notNull().default(false),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_blueprint_usage_subject').on(t.subjectKind, t.subjectId, t.eventType),
  index('idx_blueprint_usage_blueprint').on(t.blueprintId),
  index('idx_blueprint_usage_user').on(t.userId),
  index('idx_blueprint_usage_occurred').on(t.occurredAt),
]);
