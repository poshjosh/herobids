import { pgTable, text, varchar, timestamp, jsonb, integer, numeric, index } from 'drizzle-orm/pg-core';
import type { AgentRiskOverrides, UnifiedAgentConfig, AgentRuntimePolicyOverrides } from '@herobids/domain';
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
  /** UX style hint used to derive defaults (careful, balanced, bold). Informational only. */
  style: varchar('style', { length: 16 }),
  /** Per-agent runtime policy overrides — sparse JSONB of fields the user explicitly set beyond the style default. */
  runtimePolicyOverrides: jsonb('runtime_policy_overrides').$type<AgentRuntimePolicyOverrides | null>(),
  /** High-level goal injected into every agent prompt tick */
  prompt: text('prompt').notNull(),                          // was: goal
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
  /** Notification delivery policy — controls email fanout for send_message */
  notificationPolicy: jsonb('notification_policy').$type<{
    sendMessage?: {
      email?: {
        enabled: boolean;
        source: 'explicit_prompt' | 'explicit_update';
        enabledAt?: string;
      };
    };
  } | null>(),
  /** Execution mode for bots this agent creates: paper | shadow | live */
  executionMode: text('execution_mode').notNull().default('paper'),
  /** Guard rails — broker-enforced, user-configured */
  dailyLossLimit: numeric('daily_loss_limit', { precision: 20, scale: 8 }), // max P&L loss/day (USD)
  /** Max equity drawdown from session peak (USD). Separate from dailyLossLimit — independent enforcement. Default: effectively unlimited. */
  maxDrawdown: numeric('max_drawdown', { precision: 20, scale: 8 }),
  maxBots: integer('max_bots'),                              // max concurrent bots (agent-level override)
  maxSlippageBps: integer('max_slippage_bps'),               // max slippage in basis points
  maxOpenPositions: integer('max_open_positions'),
  maxPositionSizePct: numeric('max_position_size_pct', { precision: 5, scale: 2 }),
  stopLossPct: numeric('stop_loss_pct', { precision: 5, scale: 2 }),
  stopLossCooldownMs: integer('stop_loss_cooldown_ms'),
  /** User-configured base cadence in milliseconds. Runtime may still widen this when idle or after failures. */
  tickIntervalMs: integer('tick_interval_ms'),
  /** Deployable allocation cap in USD — the amount the agent may trade with, not the full wallet balance. */
  capital: numeric('capital', { precision: 20, scale: 8 }),
  /** Agent runtime risk overrides — only fields the agent has actively adjusted (separate from creator config). */
  riskOverrides: jsonb('risk_overrides').$type<AgentRiskOverrides | null>(),
  /** Unified agent config — technical + intelligence + execution + risk overrides set by the agent at runtime. */
  unifiedConfig: jsonb('unified_config').$type<UnifiedAgentConfig | null>(),
  /** Per-agent open position escalation to judge policy: never | uncovered_or_triggered | always */
  openPositionEscalationToJudgePolicy: text('open_position_escalation_to_judge_policy').notNull().default('uncovered_or_triggered'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agents_user_id').on(t.userId),
  index('idx_agents_status').on(t.status),
]);
