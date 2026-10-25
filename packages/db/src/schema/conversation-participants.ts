import { pgTable, text, primaryKey, index } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';

/**
 * Who takes part in a conversation (schema note 2.2). `participant_id` is a user or agent id with no
 * foreign key, because the type column decides which table it names. The recipient of a peer message is
 * the participant that is not the sender.
 */
export const conversationParticipants = pgTable('conversation_participants', {
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  /** user | agent */
  participantType: text('participant_type').notNull(),
  participantId: text('participant_id').notNull(),
}, (t) => [
  primaryKey({ name: 'conversation_participants_pk', columns: [t.conversationId, t.participantType, t.participantId] }),
  // Finds the conversations of an agent or user.
  index('idx_conversation_participants_participant').on(t.participantType, t.participantId),
]);
