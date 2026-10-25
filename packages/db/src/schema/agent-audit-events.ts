import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Agent audit events: an append-only record of agent creation, child-limit, creator-action and deletion
 * events (001-agent-creating-agents §11). Rows are never updated or deleted.
 *
 * `detail` holds counts and ids only. Prompts, configuration, keys and message text never belong here;
 * the writer in `agent-audit.ts` types the allowed keys.
 */
export const agentAuditEvents = pgTable('agent_audit_events', {
  id: text('id').primaryKey(),
  /** The owner of the agents involved. */
  userId: text('user_id').notNull().references(() => users.id),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_audit_events_user_created').on(t.userId, t.createdAt),
  index('idx_agent_audit_events_target').on(t.targetId),
]);
