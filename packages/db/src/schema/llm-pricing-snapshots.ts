import { pgTable, text, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * llm_pricing_snapshots — timestamped snapshots of LLM provider pricing.
 * One active row per provider at a time (enforced by partial unique index).
 * Static providers seeded from config/providers.yaml on startup.
 * Dynamic providers (OpenRouter) fetched periodically by the worker.
 */
export const llmPricingSnapshots = pgTable(
  'llm_pricing_snapshots',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    models: jsonb('models').notNull().$type<Record<string, { inputUsdPerM: number; outputUsdPerM: number; [key: string]: unknown }>>(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_llm_pricing_snapshots_provider_active').on(t.provider, t.isActive),
    // Partial unique: only one active row per provider.
    // Inactive rows kept for audit / history.
    uniqueIndex('uq_llm_pricing_snapshots_provider_active')
      .on(t.provider)
      .where(sql`is_active = true`),
  ],
);
