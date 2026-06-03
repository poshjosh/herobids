import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { agents } from './agents.js';
import { tradingInstances } from './trading-instances.js';

/**
 * Agent-to-trading-instance links.
 * An agent may only link to instances owned by the same user.
 * V1: one active link per agent (enforced by unique constraint on active links).
 */
export const agentInstanceLinks = pgTable('agent_instance_links', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  tradingInstanceId: text('trading_instance_id').notNull().references(() => tradingInstances.id),
  /** Link status: active, paused, revoked */
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_instance_links_agent_id').on(t.agentId),
  index('idx_agent_instance_links_trading_instance_id').on(t.tradingInstanceId),
  // V1: one active link per agent
  uniqueIndex('uq_agent_instance_links_active_agent')
    .on(t.agentId)
    .where(sql`${t.status} = 'active'`),
]);
