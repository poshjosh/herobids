import { pgTable, text, timestamp, bigint, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { billingAccounts } from './billing-accounts.js';
import { billingPeriods } from './billing-periods.js';

export const billingLedgerEntries = pgTable(
  'billing_ledger_entries',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => billingAccounts.id),
    periodId: text('period_id')
      .references(() => billingPeriods.id),
    /**
     * included_credit | top_up_credit | usage_charge | manual_adjustment |
     * reversal | reservation | reservation_release | invoice_settlement
     */
    entryType: text('entry_type').notNull(),
    /** credit | debit */
    direction: text('direction').notNull(),
    amountMicrousd: bigint('amount_microusd', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    /** plan | top_up_checkout | usage_event | operator | invoice */
    sourceType: text('source_type').notNull(),
    /** FK to the originating record (e.g. usage event ID, checkout session ID) */
    sourceId: text('source_id'),
    description: text('description'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_billing_ledger_account_created').on(t.accountId, t.createdAt),
    index('idx_billing_ledger_period_id').on(t.periodId),
    index('idx_billing_ledger_entry_type').on(t.entryType),
    unique('uq_billing_ledger_source_entry').on(t.sourceType, t.sourceId, t.entryType),
  ],
);
