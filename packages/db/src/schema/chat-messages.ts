import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { chatThreads } from './chat-threads.js';

/**
 * Chat messages — persisted user and assistant messages within a chat thread.
 *
 * Only replayable visible messages are stored here. Hidden workflow state
 * (summaries, internal context) lives in chat_threads.metadata.
 *
 * v1 scope: users must not paste secrets into chat messages.
 * Automatic redaction is not implemented in v1.
 */
export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(), // UUIDv7
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  /** 'user' | 'assistant' */
  role: text('role').notNull(),
  /** Visible chat text content */
  content: text('content').notNull(),
  /**
   * Structured actions attached to this message:
   * e.g. [{ type: 'form', form: 'connection', props: {...} },
   *       { type: 'quick_replies', options: [...] },
   *       { type: 'confirm', props: {...} }]
   */
  actions: jsonb('actions'),
  /** Token usage for cost tracking: { inputTokens, outputTokens, costUsd } */
  usage: jsonb('usage').$type<{
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  } | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_chat_messages_thread_id').on(t.threadId),
  index('idx_chat_messages_created_at').on(t.createdAt),
]);
