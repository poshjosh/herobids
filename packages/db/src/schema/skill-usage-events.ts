import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { skills } from './skills.js';
import { skillRevisions } from './skill-revisions.js';
import { users } from './users.js';
import { agents } from './agents.js';
import { agentRuntimeSessions } from './agent-runtime-sessions.js';

/**
 * Immutable skill engagement facts used for popularity/trending rollups.
 */
export const skillUsageEvents = pgTable('skill_usage_events', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'restrict' }),
  skillRevisionId: text('skill_revision_id').notNull().references(() => skillRevisions.id, { onDelete: 'restrict' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  sessionId: text('session_id').references(() => agentRuntimeSessions.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_skill_usage_events_skill_occurred').on(t.skillId, t.occurredAt),
  index('idx_skill_usage_events_type_occurred').on(t.eventType, t.occurredAt),
  index('idx_skill_usage_events_user_occurred').on(t.userId, t.occurredAt),
]);
