import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { agentConnections } from './agent-connections.js';

/**
 * Agent connection audit — append-only record of every agent_connections
 * state transition.
 *
 * Rows are NEVER updated or deleted after insertion. This table is the
 * authoritative audit trail for agent-connection lifecycle events.
 *
 * action values:
 *   "granted"   — a new agent_connection became active
 *   "revoked"   — an agent_connection was revoked (by user or platform)
 */
export const agentConnectionAudit = pgTable('agent_connection_audit', {
  id: text('id').primaryKey(),               // UUIDv7
  agentConnectionId: text('agent_connection_id').notNull()
    .references(() => agentConnections.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  reason: text('reason'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_connection_audit_ac_id').on(t.agentConnectionId),
  index('idx_agent_connection_audit_created_at').on(t.createdAt),
]);
