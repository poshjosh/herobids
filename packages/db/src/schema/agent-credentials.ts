import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { userCredentials } from './user-credentials.js';

/**
 * Agent credentials — agent-scoped references to user_credentials.
 * An agent may be authorized to use specific credentials.
 * Cascade-deleted when the agent is deleted.
 */
export const agentCredentials = pgTable('agent_credentials', {
  id: text('id').primaryKey(),               // UUIDv7
  agentId: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull()
    .references(() => userCredentials.id, { onDelete: 'restrict' }),
  /** Human-readable label for this credential within the agent: "hyperliquid_main", "twitter_api" */
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_credentials_agent_id').on(t.agentId),
]);
