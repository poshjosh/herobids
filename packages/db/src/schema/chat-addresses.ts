import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { users } from './users.js';

/**
 * Chat addresses — a user's address on a chat provider (telegram | whatsapp | sms).
 *
 * The platform's shared endpoint (bot token, sender number) is operator config,
 * not stored here. One row per (user, agent scope, provider); agent_id null is the
 * user-level default and an agent_id set is that agent's override.
 */
export const chatAddresses = pgTable('chat_addresses', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Null = user-level default; set = agent-level override */
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
  /** telegram | whatsapp | sms */
  provider: text('provider').notNull(),
  /** Provider-specific address: Telegram chat id, E.164 phone number, ... */
  address: text('address').notNull(),
  /** active | revoked | pending_optin */
  status: text('status').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  /** How opt-in was captured (see 060). */
  consentSource: text('consent_source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // NULLS NOT DISTINCT so two user-level rows (agent_id null) for the same provider still conflict.
  unique('uq_chat_addresses_user_agent_provider')
    .on(t.userId, t.agentId, t.provider)
    .nullsNotDistinct(),
  // Inbound replies resolve the owning user/agent by (provider, address).
  index('idx_chat_addresses_provider_address').on(t.provider, t.address),
  // Effective-address resolution for an agent: (agent_id, provider).
  index('idx_chat_addresses_agent_provider').on(t.agentId, t.provider),
]);
