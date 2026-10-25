import { pgTable, text, varchar, timestamp, jsonb, integer, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { UnifiedAgentConfig, AgentRuntimePolicyOverrides, WakePreferences, StrategyIdentity } from '@herobids/domain';
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
  /** Agent permission level: restricted, standard, or full. Controls tool visibility and sandbox config. */
  permissionLevel: varchar('permission_level', { length: 16 }).notNull().default('standard'),
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
  /**
   * Notification delivery policy — controls delivery preferences for agent notifications.
   * Note: email fanout from send_message has been removed (2026-07-17).
   * Agent-initiated email is handled via the dedicated send_email tool.
   * The sendMessage.email.enabled field is retained as legacy but is no longer used at runtime.
   */
  notificationPolicy: jsonb('notification_policy').$type<{
    sendMessage?: {
      email?: {
        enabled: boolean;
        source: 'explicit_prompt' | 'explicit_update';
        enabledAt?: string;
      };
    };
  } | null>(),
  maxBots: integer('max_bots'),                              // max concurrent bots (agent-level override)
  /** User-configured base cadence in milliseconds. Runtime may still widen this when idle or after failures. */
  tickIntervalMs: integer('tick_interval_ms'),
  /** Optional strategy identity — absent for non-trading agents (capabilityMode: intelligence). */
  strategy: jsonb('strategy').$type<StrategyIdentity | null>(),
  /** Unified agent config — technical + intelligence + execution + risk overrides set by the agent at runtime. */
  unifiedConfig: jsonb('unified_config').$type<UnifiedAgentConfig | null>(),
  /** Per-agent wake source subscription preferences. If absent/empty, agent receives all sources. */
  wakePreferences: jsonb('wake_preferences').$type<WakePreferences | null>(),
  /** Per-agent open position escalation to judge policy: never | uncovered_or_triggered | always */
  openPositionEscalationToJudgePolicy: text('open_position_escalation_to_judge_policy').notNull().default('uncovered_or_triggered'),
  /** Blueprint attribution — both null (not from blueprint) or both non-null (from blueprint revision) */
  blueprintId: text('blueprint_id'),
  blueprintRevisionId: text('blueprint_revision_id'),
  /** Who created this agent. Values: user | agent | system. Typed in code only; no DB enum/CHECK, so the migration stays additive. */
  creatorType: text('creator_type', { enum: ['user', 'agent', 'system'] }).notNull().default('user'),
  /** Creating agent id when creatorType = 'agent'; user id when 'user'; null for 'system'. */
  creatorId: text('creator_id'),
  /** Parent agent for child agents. NO ACTION: the delete transaction re-parents children explicitly before deleting. */
  parentAgentId: text('parent_agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'no action' }),
  /** Generations below a user-created agent: 0 for user-created, parent depth + 1 for children. */
  depth: integer('depth').notNull().default(0),
  /** How many child agents this agent may create. User-set; starts at 0. */
  childAgentLimit: integer('child_agent_limit').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agents_user_id').on(t.userId),
  index('idx_agents_status').on(t.status),
  index('idx_agents_parent_agent_id').on(t.parentAgentId),
  index('idx_agents_user_creator_type').on(t.userId, t.creatorType),
]);
