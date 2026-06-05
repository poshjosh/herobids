import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

/**
 * Agent messages — raw envelope metadata for dedupe, correlation, replay cursoring, and diagnostics.
 * This is NOT the trading source of truth; it supports protocol semantics.
 * Trading truth remains in decisions, plans, fills, positions, and journal tables.
 */
export const agentMessages = pgTable('agent_messages', {
  id: text('id').primaryKey(),
  /** Unique message ID for dedupe */
  messageId: text('message_id').notNull().unique(),
  /** Correlation ID grouping request/response messages */
  correlationId: text('correlation_id').notNull(),
  /** Actor type that authored this message: agent, bot, user, system */
  actorType: text('actor_type').notNull(),
  /** Stable actor identifier */
  actorId: text('actor_id').notNull(),
  /** Agent that owns this message stream (primary grouping key; was tradingInstanceId) */
  agentId: text('agent_id').notNull(),
  /** Bot this message is scoped to (nullable — null for agent-level messages) */
  botId: text('bot_id'),
  /** Message type from the catalog (e.g. agent.decision.submit) */
  type: text('type').notNull(),
  /** Message direction: inbound (agent→platform) or outbound (platform→agent) */
  direction: text('direction').notNull(),
  /** Schema version (e.g. v1) */
  schemaVersion: text('schema_version').notNull().default('v1'),
  /** Optional sequence number for ordering */
  sequence: integer('sequence'),
  /** Optional trace ID for distributed tracing */
  traceId: text('trace_id'),
  /** Processing status: received | processed | rejected | failed */
  processingStatus: text('processing_status').notNull().default('received'),
  /** Error details if processing failed */
  errorDetail: jsonb('error_detail').$type<{ code: string; message: string } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_messages_agent_id').on(t.agentId),
  index('idx_agent_messages_bot_id').on(t.botId),
  index('idx_agent_messages_correlation_id').on(t.correlationId),
  index('idx_agent_messages_type').on(t.type),
  index('idx_agent_messages_actor_id').on(t.actorId),
  index('idx_agent_messages_created_at').on(t.createdAt),
]);
