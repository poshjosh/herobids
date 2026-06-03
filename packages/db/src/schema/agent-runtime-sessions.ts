import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { tradingInstances } from './trading-instances.js';

/**
 * Agent runtime sessions — tracks lifecycle of isolated agent runtime processes.
 * One session = one agent runtime connected to one trading instance.
 */
export const agentRuntimeSessions = pgTable('agent_runtime_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  tradingInstanceId: text('trading_instance_id').notNull().references(() => tradingInstances.id),
  /** Runtime status: starting, running, unhealthy, stopped, crashed */
  status: text('status').notNull().default('starting'),
  /** Last heartbeat timestamp */
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  /** Resource telemetry: cpu_pct, memory_bytes */
  cpuPct: integer('cpu_pct'),
  memoryBytes: integer('memory_bytes'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
}, (t) => [
  index('idx_agent_runtime_sessions_agent_id').on(t.agentId),
  index('idx_agent_runtime_sessions_trading_instance_id').on(t.tradingInstanceId),
  index('idx_agent_runtime_sessions_status').on(t.status),
]);
