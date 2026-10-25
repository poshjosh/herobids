import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Conversations: one record of a thread between participants (002 section 4.1, schema note 2.1).
 *
 * `user_agent` conversations have one row per agent, with a derived id. `agent_agent` conversations
 * (peer messaging) have one row per agent pair, named by `peer_key`.
 */
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  /** user_agent | agent_agent */
  kind: text('kind').notNull(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** agent_agent only: the two agent ids, sorted and joined with ':'. Null otherwise. */
  peerKey: text('peer_key'),
  /** Set on every new message. Orders the owner's thread list. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One thread per agent pair, enforced under concurrent creates.
  uniqueIndex('uq_conversations_peer_key').on(t.peerKey).where(sql`${t.kind} = 'agent_agent'`),
  index('idx_conversations_owner_last_message').on(t.ownerUserId, t.lastMessageAt.desc()),
]);
