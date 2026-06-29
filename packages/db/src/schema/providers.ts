import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

/**
 * Providers — supported external platforms and systems.
 *
 * Each provider defines a set of capabilities it supports (trading, messaging,
 * social, automation, etc.). Capability grants to connections derive their
 * available capabilities from the provider record, which is why the
 * agent_connections table does not need a capabilityFamily column.
 *
 * Provider IDs are stable slugs (e.g. "hyperliquid", "jupiter").
 */
export const providers = pgTable('providers', {
  id: text('id').primaryKey(),               // e.g. "hyperliquid"
  name: text('name').notNull(),               // human-readable, e.g. "Hyperliquid"
  /** Capability families this provider supports: ["trading", "automation", etc.] */
  capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
  /** active | deprecated | removed */
  status: text('status').notNull().default('active'),
  /** Provider type: "dex_perp" | "dex_spot" | "cex" | "social" | "messaging" */
  providerType: text('provider_type'),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_providers_status').on(t.status),
  index('idx_providers_provider_type').on(t.providerType),
]);
