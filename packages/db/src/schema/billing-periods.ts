import { pgTable, text, timestamp, bigint, index, unique } from 'drizzle-orm/pg-core';
import { billingAccounts } from './billing-accounts.js';
import { billingRateCards } from './billing-rate-cards.js';

export const billingPeriods = pgTable(
  'billing_periods',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => billingAccounts.id),
    /** Snapshot of the plan ID active at period open */
    planIdSnapshot: text('plan_id_snapshot').notNull(),
    rateCardId: text('rate_card_id')
      .notNull()
      .references(() => billingRateCards.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** Credits included from plan packaging, in microusd */
    includedCreditMicrousd: bigint('included_credit_microusd', { mode: 'number' }).notNull().default(0),
    softCapMicrousd: bigint('soft_cap_microusd', { mode: 'number' }),
    hardCapMicrousd: bigint('hard_cap_microusd', { mode: 'number' }),
    /** Cumulative rated usage charges this period, in microusd */
    usageChargeMicrousd: bigint('usage_charge_microusd', { mode: 'number' }).notNull().default(0),
    /** Credits applied against usage charges so far, in microusd */
    creditAppliedMicrousd: bigint('credit_applied_microusd', { mode: 'number' }).notNull().default(0),
    /** Reserved (pre-authorized) amount, in microusd */
    reservedMicrousd: bigint('reserved_microusd', { mode: 'number' }).notNull().default(0),
    /** Net remaining balance (includedCredit + topUps - usageCharge), in microusd */
    balanceMicrousd: bigint('balance_microusd', { mode: 'number' }).notNull().default(0),
    /** open | closing | closed */
    status: text('status').notNull().default('open'),
    externalInvoiceId: text('external_invoice_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_billing_periods_account_start_end').on(t.accountId, t.periodStart, t.periodEnd),
    index('idx_billing_periods_account_status').on(t.accountId, t.status),
  ],
);
