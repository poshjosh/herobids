import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Chat threads — persisted conversation threads for the Guided Setup onboarding chat.
 *
 * Each thread represents one onboarding conversation. In v1, a thread creates
 * at most one agent. Thread metadata tracks the structured summary used by
 * the onboarding runtime, plus the created agent ID when the thread completes.
 */
export const chatThreads = pgTable('chat_threads', {
  id: text('id').primaryKey(), // UUIDv7
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Auto-generated title from first user message */
  title: text('title'),
  /**
   * Structured thread state — NOT persisted as chat messages.
   * Tracks: summary (preset, venue, capital, connectionIds, step), createdAgentId, completedAt.
   */
  metadata: jsonb('metadata').$type<{
    createdAgentId?: string;
    completedAt?: string;
    summary?: {
      preset?: string;
      venue?: string;
      capital?: string;
      connectionIds?: string[];
      step?: string;
    };
  } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_chat_threads_user_id').on(t.userId),
  index('idx_chat_threads_updated_at').on(t.updatedAt),
]);
