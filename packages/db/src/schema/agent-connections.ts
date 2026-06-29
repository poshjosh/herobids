import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { connections } from './connections.js';

/**
 * Agent connections — records that a user has granted an agent access to a
 * connection.
 *
 * This replaces the former capability_grants table. The simpler model does
 * NOT include a capabilityFamily column because capabilities are derived from
 * the provider record (providers.capabilities), not duplicatively stored here.
 *
 * One active row per (agent, connection). Revoked rows are retained for audit.
 */
export const agentConnections = pgTable('agent_connections', {
  id: text('id').primaryKey(),               // UUIDv7
  agentId: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull()
    .references(() => connections.id, { onDelete: 'restrict' }),
  /** active | revoked */
  status: text('status').notNull().default('active'),
  /** userId of the granter */
  grantedBy: text('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_connections_agent_id').on(t.agentId),
  index('idx_agent_connections_connection_id').on(t.connectionId),
  index('idx_agent_connections_status').on(t.status),
  // One active row per (agent, connection). Revoked rows are retained for audit.
  uniqueIndex('uq_agent_connections_active')
    .on(t.agentId, t.connectionId)
    .where(sql`status = 'active'`),
]);
