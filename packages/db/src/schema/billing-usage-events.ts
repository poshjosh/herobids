import { pgTable, text, timestamp, bigint, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { agents } from './agents.js';
import { agentRuntimeSessions } from './agent-runtime-sessions.js';
import { billingAccounts } from './billing-accounts.js';

export const billingUsageEvents = pgTable(
  'billing_usage_events',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => billingAccounts.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    agentId: text('agent_id')
      .references(() => agents.id),
    sessionId: text('session_id')
      .references(() => agentRuntimeSessions.id),
    skillId: text('skill_id'),
    /** llm_call | agent_runtime | manual_adjustment */
    sourceType: text('source_type').notNull(),
    /** llm.input_tokens | llm.output_tokens | llm.reasoning_tokens | agent.runtime_ms */
    meterKey: text('meter_key').notNull(),
    provider: text('provider'),
    model: text('model'),
    quantity: bigint('quantity', { mode: 'number' }).notNull(),
    /** tokens | milliseconds */
    unit: text('unit').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_billing_usage_events_idempotency_key').on(t.idempotencyKey),
    index('idx_billing_usage_events_account_occurred').on(t.accountId, t.occurredAt),
    index('idx_billing_usage_events_agent_occurred').on(t.agentId, t.occurredAt),
    index('idx_billing_usage_events_session_id').on(t.sessionId),
    index('idx_billing_usage_events_meter_occurred').on(t.meterKey, t.occurredAt),
  ],
);
