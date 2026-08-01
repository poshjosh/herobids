import { pgTable, text, timestamp, jsonb, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { blueprints } from './blueprints.js';

/**
 * Idempotent fork requests — records blueprint fork operations.
 * Composite FK to blueprint_revisions(blueprint_id, id) is added in migration SQL.
 */
export const blueprintForkRequests = pgTable('blueprint_fork_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  sourceBlueprintId: text('source_blueprint_id').notNull(),
  sourceBlueprintRevisionId: text('source_blueprint_revision_id').notNull(),
  forkBlueprintId: text('fork_blueprint_id').notNull().references((): AnyPgColumn => blueprints.id, { onDelete: 'restrict' }),
  responsePayload: jsonb('response_payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_bpfr_user_key').on(t.userId, t.idempotencyKey),
]);
