import { pgTable, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';

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
    index('uq_llm_pricing_snapshots_provider_active')
      .on(t.provider)
      .where(t.isActive.eq(true))
      .unique(),
  ],
);
