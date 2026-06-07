import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { tradingBindings } from './trading-bindings.js';

/**
 * Capability grants — records that a user has granted an agent scoped access
 * to a connection for a specific capability family.
 *
 * Grants are capability-family-scoped: one connection may produce separate
 * grants for trading, automation, communications, etc. Each agent may hold
 * multiple grants across different families.
 *
 * Revocation disables use immediately. Revoked rows are retained for audit.
 */
export const capabilityGrants = pgTable('capability_grants', {
  id: text('id').primaryKey(),               // UUIDv7
  agentId: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  bindingId: text('binding_id').notNull()
    .references(() => tradingBindings.id, { onDelete: 'restrict' }),
  /** Capability family this grant covers: "trading" | "automation" | etc. */
  capabilityFamily: text('capability_family').notNull(),
  /** active | revoked */
  status: text('status').notNull().default('active'),
  /** userId of the granter */
  grantedBy: text('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when status transitions to revoked */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Arbitrary per-grant metadata */
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_capability_grants_agent_id').on(t.agentId),
  index('idx_capability_grants_binding_id').on(t.bindingId),
  index('idx_capability_grants_status').on(t.status),
  // Partial unique: one ACTIVE grant per (agent, binding, family).
  // Revoked rows are retained for audit and must not block re-granting.
  uniqueIndex('uq_capability_grants_active')
    .on(t.agentId, t.bindingId, t.capabilityFamily)
    .where(sql`status = 'active'`),
]);
