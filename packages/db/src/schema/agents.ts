import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Agents — user-owned autonomous reasoning runtimes.
 * An agent proposes strategic intent through the message protocol;
 * it never owns execution authority directly.
 */
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  /** High-level goal description visible to the user */
  goal: text('goal').notNull(),
  /** Preset used at create time (e.g. momentum_trader, range_trader, dca_accumulator) */
  preset: text('preset'),
  /** Current status: starting, active, paused, stopped */
  status: text('status').notNull().default('stopped'),
  /** Pause state detail (reason, requested_by, paused_at) */
  pauseState: jsonb('pause_state').$type<{ reason: string; requestedBy: string; pausedAt: string } | null>(),
  /** Tool policy grants for this agent */
  toolPolicy: jsonb('tool_policy').$type<Record<string, unknown>>(),
  /** Model/LLM configuration policy */
  modelPolicy: jsonb('model_policy').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agents_user_id').on(t.userId),
  index('idx_agents_status').on(t.status),
]);
