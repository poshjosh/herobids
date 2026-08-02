import { pgTable, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Idempotent instantiation requests — records blueprint→agent/bot instantiation.
 * Composite FK to blueprint_revisions(blueprint_id, id) is added in migration SQL.
 */
export const blueprintInstantiationRequests = pgTable('blueprint_instantiation_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  blueprintId: text('blueprint_id').notNull(),
  blueprintRevisionId: text('blueprint_revision_id').notNull(),
  actorKind: text('actor_kind').notNull(), // 'agent' or 'bot'
  actorId: text('actor_id').notNull(),
  responsePayload: jsonb('response_payload').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_bpir_user_key').on(t.userId, t.idempotencyKey),
]);
