import { pgTable, text, timestamp, bigint, jsonb, index } from 'drizzle-orm/pg-core';
import { billingRateCards } from './billing-rate-cards.js';

export const billingRateCardItems = pgTable(
  'billing_rate_card_items',
  {
    id: text('id').primaryKey(),
    rateCardId: text('rate_card_id')
      .notNull()
      .references(() => billingRateCards.id),
    /** llm.input_tokens | llm.output_tokens | llm.reasoning_tokens | agent.runtime_ms */
    meterKey: text('meter_key').notNull(),
    /** Optional provider scope — null means applies to all providers */
    provider: text('provider'),
    /** Optional glob-style model pattern — null means applies to all models */
    modelPattern: text('model_pattern'),
    /** Price in microusd per `perUnit` quantity */
    priceMicrousd: bigint('price_microusd', { mode: 'number' }).notNull(),
    /** Denominator — e.g. 1000 for "per 1K tokens" */
    perUnit: bigint('per_unit', { mode: 'number' }).notNull(),
    /** up | down | nearest */
    roundingMode: text('rounding_mode').notNull().default('up'),
    minimumChargeMicrousd: bigint('minimum_charge_microusd', { mode: 'number' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_billing_rate_card_items_card_meter').on(t.rateCardId, t.meterKey),
  ],
);
