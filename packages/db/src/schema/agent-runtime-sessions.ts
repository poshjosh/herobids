import { pgTable, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';

/**
 * Agent runtime sessions — tracks lifecycle of isolated agent runtime processes.
 * One session = one agent runtime container. A single session manages all of the
 * agent's bots; the session is not scoped to a single bot.
 */
export const agentRuntimeSessions = pgTable('agent_runtime_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  // tradingInstanceId REMOVED — sessions are agent-scoped; one container manages all agent bots
  /** Runtime status: starting | launching | running | unhealthy | stopped | crashed */
  status: text('status').notNull().default('starting'),
  /** Last heartbeat timestamp */
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  /** Resource telemetry */
  cpuPct: integer('cpu_pct'),
  memoryBytes: integer('memory_bytes'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_agent_runtime_sessions_agent_id').on(t.agentId),
  index('idx_agent_runtime_sessions_status').on(t.status),
  // Replaces the session guard that was on agent_instance_links.
  // Prevents two concurrent active/starting/unhealthy sessions for the same agent.
  uniqueIndex('uq_agent_runtime_sessions_active_agent')
    .on(t.agentId)
    .where(sql`${t.status} NOT IN ('stopped', 'crashed')`),
]);
