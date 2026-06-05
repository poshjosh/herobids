import { pgTable, text, timestamp, jsonb, integer, numeric, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Agents — user-owned autonomous reasoning runtimes.
 * An agent reasons, decides, and manages bots via the broker tool protocol.
 * Skills define what an agent can do; guard rails cap how much it can spend/risk.
 */
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  /** High-level goal injected into every agent prompt tick */
  prompt: text('prompt').notNull(),                          // was: goal
  // preset REMOVED — replaced by skillIds text[]
  /** Ordered list of skill IDs active for this agent.
   *  The base skill is auto-injected at runtime and not stored here. */
  skillIds: text('skill_ids').array().notNull().default(sql`'{}'::text[]`),
  /** Current status: stopped | starting | active | paused | crashed */
  status: text('status').notNull().default('stopped'),
  /** Pause state detail (reason, requested_by, paused_at) */
  pauseState: jsonb('pause_state').$type<{ reason: string; requestedBy: string; pausedAt: string } | null>(),
  /** Tool policy grants for this agent (per-capability overrides) */
  toolPolicy: jsonb('tool_policy').$type<Record<string, unknown>>(),
  /** Model/LLM configuration policy */
  modelPolicy: jsonb('model_policy').$type<Record<string, unknown>>(),
  /** Telegram chat ID for send_message and platform safety alert delivery */
  telegramChatId: text('telegram_chat_id'),
  /** Execution mode for bots this agent creates: paper | shadow | live */
  executionMode: text('execution_mode'),
  /** Guard rails — broker-enforced, user-configured */
  dailyTokenBudget: integer('daily_token_budget'),           // max LLM tokens/day
  dailyLossLimit: numeric('daily_loss_limit', { precision: 20, scale: 8 }), // max P&L loss/day (USD)
  maxBots: integer('max_bots'),                              // max concurrent bots (agent-level override)
  maxSlippageBps: integer('max_slippage_bps'),               // max slippage in basis points
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agents_user_id').on(t.userId),
  index('idx_agents_status').on(t.status),
]);
