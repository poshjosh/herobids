import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { getLlmModelRateCardItems, type ModelPricing, type ProvidersYaml } from '@herobids/domain';
import type { Database } from './index.js';
import {
  billingAccounts,
  billingUsageEvents,
  billingRateCards,
  billingRateCardItems,
  billingPeriods,
  billingLedgerEntries,
  agents,
  agentRuntimeSessions,
  users,
  llmPricingSnapshots,
} from './schema/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InsertUsageEvent {
  id: string;
  accountId: string;
  userId: string;
  agentId?: string | null;
  sessionId?: string | null;
  skillId?: string | null;
  sourceType: string;
  meterKey: string;
  provider?: string | null;
  model?: string | null;
  quantity: number;
  unit: string;
  idempotencyKey: string;
  occurredAt: Date;
  metadata?: Record<string, unknown> | null;
}

export interface InsertLedgerEntry {
  id: string;
  accountId: string;
  periodId?: string | null;
  entryType: string;
  direction: 'credit' | 'debit';
  amountMicrousd: number;
  currency?: string;
  sourceType: string;
  sourceId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RecordUsageBatchInput {
  events: InsertUsageEvent[];
  /** If provided, rate events and apply ledger effects in the same transaction */
  rateAndApply?: boolean;
  defaultRateCardName?: string;
}

export interface UsageSummaryFilters {
  periodId?: string;
  from?: Date;
  to?: Date;
}

export interface UsageEventFilters {
  limit?: number;
  offset?: number;
  meterKey?: string;
  agentId?: string;
  sessionId?: string;
  periodId?: string;
  from?: Date;
  to?: Date;
}

export interface SpendCaps {
  softCapMicrousd?: number | null;
  hardCapMicrousd?: number | null;
}

export interface BillingAccountCreateOptions {
  currency?: string;
  softCapMicrousd?: number | null;
  hardCapMicrousd?: number | null;
}

export interface OpenTopUpCreditInput {
  accountId: string;
  periodId: string;
  amountMicrousd: number;
  sourceId: string;
  description?: string;
}

export type AccountStatus = 'active' | 'soft_limited' | 'hard_limited' | 'suspended';

export interface BillingAccountRow {
  id: string;
  ownerUserId: string;
  status: string;
  currency: string;
  activePlanId: string;
  softCapMicrousd: number | null;
  hardCapMicrousd: number | null;
  lastEvaluatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DefaultRateCardSeedItem {
  meterKey: 'llm.input_tokens' | 'llm.output_tokens' | 'llm.reasoning_tokens' | 'agent.runtime_ms';
  priceMicrousd: number;
  perUnit: number;
}

export interface RateCardSeedItem {
  meterKey: string;
  /** Scope to a specific provider — null / absent means all providers */
  provider?: string | null;
  /** Exact model ID or glob with trailing * — null / absent means all models */
  modelPattern?: string | null;
  priceMicrousd: number;
  perUnit: number;
}

const DEFAULT_RATE_CARD_ITEMS: DefaultRateCardSeedItem[] = [
  { meterKey: 'llm.input_tokens', priceMicrousd: 2_500, perUnit: 1_000 },
  { meterKey: 'llm.output_tokens', priceMicrousd: 10_000, perUnit: 1_000 },
  { meterKey: 'llm.reasoning_tokens', priceMicrousd: 15_000, perUnit: 1_000 },
  { meterKey: 'agent.runtime_ms', priceMicrousd: 100, perUnit: 60_000 },
];

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class UsageBillingRepository {
  constructor(
    private readonly db: Database,
    private readonly rateCardItems: RateCardSeedItem[] = DEFAULT_RATE_CARD_ITEMS,
    private readonly providers?: ProvidersYaml,
  ) {}

  async getUserPlanId(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ planId: users.planId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row?.planId ?? null;
  }

  async getOrCreateBillingAccountForUser(
    userId: string,
    planId: string,
    options?: BillingAccountCreateOptions,
  ): Promise<BillingAccountRow> {
    const existing = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId))
      .limit(1);

    if (existing[0]) {
      const row = existing[0] as BillingAccountRow;
      const nextPlanId = row.activePlanId !== planId ? planId : row.activePlanId;
      const nextSoftCap = options?.softCapMicrousd !== undefined ? options.softCapMicrousd ?? null : row.softCapMicrousd;
      const nextHardCap = options?.hardCapMicrousd !== undefined ? options.hardCapMicrousd ?? null : row.hardCapMicrousd;
      const nextCurrency = options?.currency ?? row.currency;

      if (
        nextPlanId !== row.activePlanId
        || nextSoftCap !== row.softCapMicrousd
        || nextHardCap !== row.hardCapMicrousd
        || nextCurrency !== row.currency
      ) {
        const [updated] = await this.db
          .update(billingAccounts)
          .set({
            activePlanId: nextPlanId,
            softCapMicrousd: nextSoftCap,
            hardCapMicrousd: nextHardCap,
            currency: nextCurrency,
            updatedAt: new Date(),
          })
          .where(eq(billingAccounts.id, row.id))
          .returning();

        return (updated as BillingAccountRow) ?? row;
      }

      return row;
    }

    const id = `acct_${userId.replace(/[^a-z0-9]/gi, '').slice(0, 16)}_${Date.now()}`;
    const [created] = await this.db
      .insert(billingAccounts)
      .values({
        id,
        ownerUserId: userId,
        status: 'active',
        currency: options?.currency ?? 'USD',
        activePlanId: planId,
        softCapMicrousd: options?.softCapMicrousd ?? null,
        hardCapMicrousd: options?.hardCapMicrousd ?? null,
      })
      .returning();

    return created as BillingAccountRow;
  }

  async getSpendState(accountId: string): Promise<{ status: string } | null> {
    const [row] = await this.db
      .select({ status: billingAccounts.status })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId))
      .limit(1);

    return row ?? null;
  }

  async getOrCreateOpenPeriod(
    accountId: string,
    now: Date,
    planIdSnapshot: string,
    rateCardId: string,
    includedCreditMicrousd: number,
    softCapMicrousd: number | null,
    hardCapMicrousd: number | null,
  ): Promise<typeof billingPeriods.$inferSelect> {
    return this.db.transaction(async (tx) => {
      // Calendar-month period boundaries
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

      const [existing] = await tx
        .select()
        .from(billingPeriods)
        .where(
          and(
            eq(billingPeriods.accountId, accountId),
            eq(billingPeriods.status, 'open'),
          ),
        )
        .orderBy(desc(billingPeriods.periodStart))
        .limit(1);

      if (existing) {
        // Close stale period if it belongs to a previous month
        if (existing.periodEnd < periodStart) {
          await tx
            .update(billingPeriods)
            .set({ status: 'closed', updatedAt: new Date() })
            .where(eq(billingPeriods.id, existing.id));
        } else {
          return existing;
        }
      }

      const id = `period_${accountId.slice(0, 12)}_${periodStart.toISOString().slice(0, 7)}`;
      const balance = includedCreditMicrousd;
      const [created] = await tx
        .insert(billingPeriods)
        .values({
          id,
          accountId,
          planIdSnapshot,
          rateCardId,
          periodStart,
          periodEnd,
          includedCreditMicrousd,
          softCapMicrousd: softCapMicrousd ?? null,
          hardCapMicrousd: hardCapMicrousd ?? null,
          usageChargeMicrousd: 0,
          creditAppliedMicrousd: 0,
          reservedMicrousd: 0,
          balanceMicrousd: balance,
          status: 'open',
        })
        .onConflictDoNothing()
        .returning();

      if (created) {
        await tx
          .insert(billingLedgerEntries)
          .values({
            id: `led_inc_${id}`,
            accountId,
            periodId: created.id,
            entryType: 'included_credit',
            direction: 'credit',
            amountMicrousd: includedCreditMicrousd,
            currency: 'USD',
            sourceType: 'plan',
            sourceId: id,
            description: `Included credits for period ${periodStart.toISOString().slice(0, 7)}`,
          })
          .onConflictDoNothing();

        return created;
      }

      // Conflict: another process opened the period concurrently — re-read
      const [refetched] = await tx
        .select()
        .from(billingPeriods)
        .where(
          and(
            eq(billingPeriods.accountId, accountId),
            eq(billingPeriods.status, 'open'),
          ),
        )
        .orderBy(desc(billingPeriods.periodStart))
        .limit(1);

      if (!refetched) {
        throw new Error(`Failed to open billing period for account ${accountId}`);
      }
      return refetched;
    });
  }

  async getActiveRateCard(name: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: billingRateCards.id })
      .from(billingRateCards)
      .where(
        and(
          eq(billingRateCards.name, name),
          eq(billingRateCards.status, 'active'),
        ),
      )
      .orderBy(desc(billingRateCards.version))
      .limit(1);

    return row ?? null;
  }

  async ensureActiveRateCard(name: string, currency = 'USD'): Promise<{ id: string }> {
    const active = await this.getActiveRateCard(name);
    if (active) {
      await this.seedDefaultRateCardItems(active.id);
      return active;
    }

    const [latest] = await this.db
      .select({ version: billingRateCards.version })
      .from(billingRateCards)
      .where(eq(billingRateCards.name, name))
      .orderBy(desc(billingRateCards.version))
      .limit(1);

    const version = (latest?.version ?? 0) + 1;
    const rateCardId = `rc_${name.replace(/[^a-z0-9_]/gi, '_')}_v${version}`;

    await this.db
      .insert(billingRateCards)
      .values({
        id: rateCardId,
        name,
        version,
        currency,
        status: 'active',
        effectiveFrom: new Date(),
      })
      .onConflictDoNothing();

    const ensured = await this.getActiveRateCard(name);
    if (!ensured) {
      throw new Error(`Failed to ensure active rate card '${name}'`);
    }

    await this.seedDefaultRateCardItems(ensured.id);
    return ensured;
  }

  private async seedDefaultRateCardItems(rateCardId: string): Promise<void> {
    const catchAllItems = this.rateCardItems.map((item) => ({
      id: `rci_${rateCardId}_${item.meterKey.replace(/[^a-z0-9_]/gi, '_')}`,
      rateCardId,
      meterKey: item.meterKey,
      provider: item.provider ?? null,
      modelPattern: item.modelPattern ?? null,
      priceMicrousd: item.priceMicrousd,
      perUnit: item.perUnit,
      roundingMode: 'up',
      minimumChargeMicrousd: null,
      metadata: { seed: 'default_v1' },
    }));

    const modelItems: Array<{
      id: string;
      rateCardId: string;
      meterKey: string;
      provider: string | null;
      modelPattern: string | null;
      priceMicrousd: number;
      perUnit: number;
      roundingMode: string;
      minimumChargeMicrousd: null;
      metadata: Record<string, string>;
    }> = [];

    if (this.providers) {
      for (const [providerId] of Object.entries(this.providers.providers)) {
        const snapshot = await this.getLatestPricingSnapshot(providerId);
        if (!snapshot) continue;
        const items = getLlmModelRateCardItems(providerId, snapshot.models as Record<string, Partial<ModelPricing>>);
        for (const item of items) {
          modelItems.push({
            id: `rci_${rateCardId}_${item.meterKey.replace(/[^a-z0-9_]/gi, '_')}_${item.provider}_${item.modelPattern.replace(/[^a-z0-9_]/gi, '_')}`,
            rateCardId,
            meterKey: item.meterKey,
            provider: item.provider,
            modelPattern: item.modelPattern,
            priceMicrousd: item.priceMicrousd,
            perUnit: item.perUnit,
            roundingMode: 'up',
            minimumChargeMicrousd: null,
            metadata: { seed: 'model_pricing_v1' },
          });
        }
      }
    }

    const allItems = [...catchAllItems, ...modelItems];
    if (allItems.length === 0) return;

    await this.db
      .insert(billingRateCardItems)
      .values(allItems)
      .onConflictDoNothing();
  }

  async getRateCardItems(rateCardId: string): Promise<typeof billingRateCardItems.$inferSelect[]> {
    return this.db
      .select()
      .from(billingRateCardItems)
      .where(eq(billingRateCardItems.rateCardId, rateCardId));
  }

  /** Insert raw usage events (idempotent via idempotency_key unique constraint) */
  async recordUsageEvents(events: InsertUsageEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.db
      .insert(billingUsageEvents)
      .values(
        events.map((e) => ({
          id: e.id,
          accountId: e.accountId,
          userId: e.userId,
          agentId: e.agentId ?? null,
          sessionId: e.sessionId ?? null,
          skillId: e.skillId ?? null,
          sourceType: e.sourceType,
          meterKey: e.meterKey,
          provider: e.provider ?? null,
          model: e.model ?? null,
          quantity: e.quantity,
          unit: e.unit,
          idempotencyKey: e.idempotencyKey,
          occurredAt: e.occurredAt,
          metadata: e.metadata ?? null,
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Atomically insert usage events, rate them, apply ledger debits, update period totals,
   * and recompute spend state — all in one transaction.
   *
   * Only events that are actually inserted (not skipped by idempotency constraint) are
   * rated and charged, preventing duplicate charges on retry.
   *
   * Returns the total charge in microusd for newly-inserted events.
   */
  async recordAndRateUsageBatch(
    events: InsertUsageEvent[],
    periodId: string,
    accountId: string,
    rateCardItems: typeof billingRateCardItems.$inferSelect[],
  ): Promise<{ totalChargeMicrousd: number; status: AccountStatus }> {
    if (events.length === 0) return { totalChargeMicrousd: 0, status: 'active' };

    let totalChargeMicrousd = 0;
    let finalStatus: AccountStatus = 'active';

    await this.db.transaction(async (tx) => {
      // Insert events; only actually-inserted rows are returned
      const inserted = await tx
        .insert(billingUsageEvents)
        .values(
          events.map((e) => ({
            id: e.id,
            accountId: e.accountId,
            userId: e.userId,
            agentId: e.agentId ?? null,
            sessionId: e.sessionId ?? null,
            skillId: e.skillId ?? null,
            sourceType: e.sourceType,
            meterKey: e.meterKey,
            provider: e.provider ?? null,
            model: e.model ?? null,
            quantity: e.quantity,
            unit: e.unit,
            idempotencyKey: e.idempotencyKey,
            occurredAt: e.occurredAt,
            metadata: e.metadata ?? null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: billingUsageEvents.id });

      if (inserted.length === 0) return;

      // Only rate events that were actually persisted (not idempotency-skipped)
      const insertedIds = new Set(inserted.map((r) => r.id));
      const eventsToRate = events.filter((e) => insertedIds.has(e.id));

      const ledgerEntries: InsertLedgerEntry[] = [];
      for (const event of eventsToRate) {
        const charge = computeCharge(event, rateCardItems);
        if (charge <= 0) continue;
        totalChargeMicrousd += charge;
        ledgerEntries.push({
          id: `led_${event.id}`,
          accountId,
          periodId,
          entryType: 'usage_charge',
          direction: 'debit',
          amountMicrousd: charge,
          sourceType: 'usage_event',
          sourceId: event.id,
          description: `${event.meterKey} × ${event.quantity}`,
        });
      }

      if (ledgerEntries.length > 0) {
        await tx
          .insert(billingLedgerEntries)
          .values(ledgerEntries.map((e) => ({
            id: e.id,
            accountId: e.accountId,
            periodId: e.periodId ?? null,
            entryType: e.entryType,
            direction: e.direction,
            amountMicrousd: e.amountMicrousd,
            currency: e.currency ?? 'USD',
            sourceType: e.sourceType,
            sourceId: e.sourceId ?? null,
            description: e.description ?? null,
            metadata: e.metadata ?? null,
          })))
          .onConflictDoNothing();

        await tx
          .update(billingPeriods)
          .set({
            usageChargeMicrousd: sql`${billingPeriods.usageChargeMicrousd} + ${totalChargeMicrousd}`,
            creditAppliedMicrousd: sql`${billingPeriods.creditAppliedMicrousd} + LEAST(${totalChargeMicrousd}, GREATEST(${billingPeriods.balanceMicrousd}, 0))`,
            balanceMicrousd: sql`${billingPeriods.balanceMicrousd} - ${totalChargeMicrousd}`,
            updatedAt: new Date(),
          })
          .where(eq(billingPeriods.id, periodId));
      }

      // Recompute spend state within the same transaction for consistency
      const [period] = await tx
        .select({
          balanceMicrousd: billingPeriods.balanceMicrousd,
          hardCapMicrousd: billingPeriods.hardCapMicrousd,
          softCapMicrousd: billingPeriods.softCapMicrousd,
          includedCreditMicrousd: billingPeriods.includedCreditMicrousd,
          usageChargeMicrousd: billingPeriods.usageChargeMicrousd,
        })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, periodId))
        .limit(1);

      if (period) {
        finalStatus = computeSpendStatus(period);
        await tx
          .update(billingAccounts)
          .set({ status: finalStatus, lastEvaluatedAt: new Date(), updatedAt: new Date() })
          .where(eq(billingAccounts.id, accountId));
      }
    });

    return { totalChargeMicrousd, status: finalStatus };
  }

  /**
   * Rate usage events and apply ledger debits + period total update in one transaction.
   * Returns the total charge in microusd.
   * @deprecated Use recordAndRateUsageBatch for atomic insert+rate+recompute.
   */
  async rateAndApplyUsageEvents(
    events: InsertUsageEvent[],
    periodId: string,
    accountId: string,
    rateCardItems: typeof billingRateCardItems.$inferSelect[],
  ): Promise<number> {
    if (events.length === 0) return 0;

    let totalChargeMicrousd = 0;
    const ledgerEntries: InsertLedgerEntry[] = [];

    for (const event of events) {
      const charge = computeCharge(event, rateCardItems);
      if (charge <= 0) continue;

      totalChargeMicrousd += charge;
      ledgerEntries.push({
        id: `led_${event.id}`,
        accountId,
        periodId,
        entryType: 'usage_charge',
        direction: 'debit',
        amountMicrousd: charge,
        sourceType: 'usage_event',
        sourceId: event.id,
        description: `${event.meterKey} × ${event.quantity}`,
      });
    }

    if (ledgerEntries.length > 0) {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(billingLedgerEntries)
          .values(ledgerEntries.map((e) => ({
            id: e.id,
            accountId: e.accountId,
            periodId: e.periodId ?? null,
            entryType: e.entryType,
            direction: e.direction,
            amountMicrousd: e.amountMicrousd,
            currency: e.currency ?? 'USD',
            sourceType: e.sourceType,
            sourceId: e.sourceId ?? null,
            description: e.description ?? null,
            metadata: e.metadata ?? null,
          })))
          .onConflictDoNothing();

        await tx
          .update(billingPeriods)
          .set({
            usageChargeMicrousd: sql`${billingPeriods.usageChargeMicrousd} + ${totalChargeMicrousd}`,
            creditAppliedMicrousd: sql`${billingPeriods.creditAppliedMicrousd} + LEAST(${totalChargeMicrousd}, GREATEST(${billingPeriods.balanceMicrousd}, 0))`,
            balanceMicrousd: sql`${billingPeriods.balanceMicrousd} - ${totalChargeMicrousd}`,
            updatedAt: new Date(),
          })
          .where(eq(billingPeriods.id, periodId));
      });
    }

    return totalChargeMicrousd;
  }

  async applyLedgerEntry(entry: InsertLedgerEntry): Promise<void> {
    await this.db
      .insert(billingLedgerEntries)
      .values({
        id: entry.id,
        accountId: entry.accountId,
        periodId: entry.periodId ?? null,
        entryType: entry.entryType,
        direction: entry.direction,
        amountMicrousd: entry.amountMicrousd,
        currency: entry.currency ?? 'USD',
        sourceType: entry.sourceType,
        sourceId: entry.sourceId ?? null,
        description: entry.description ?? null,
        metadata: entry.metadata ?? null,
      })
      .onConflictDoNothing();
  }

  async setSpendCaps(accountId: string, caps: SpendCaps): Promise<void> {
    const nextSoftCap = caps.softCapMicrousd ?? null;
    const nextHardCap = caps.hardCapMicrousd ?? null;
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(billingAccounts)
        .set({
          softCapMicrousd: nextSoftCap,
          hardCapMicrousd: nextHardCap,
          updatedAt: now,
        })
        .where(eq(billingAccounts.id, accountId));

      await tx
        .update(billingPeriods)
        .set({
          softCapMicrousd: nextSoftCap,
          hardCapMicrousd: nextHardCap,
          updatedAt: now,
        })
        .where(
          and(
            eq(billingPeriods.accountId, accountId),
            eq(billingPeriods.status, 'open'),
          ),
        );
    });
  }

  async updateAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
    await this.db
      .update(billingAccounts)
      .set({ status, lastEvaluatedAt: new Date(), updatedAt: new Date() })
      .where(eq(billingAccounts.id, accountId));
  }

  async openTopUpCreditFromWebhook(input: OpenTopUpCreditInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const entryId = `led_topup_${input.sourceId}`;
      const inserted = await tx
        .insert(billingLedgerEntries)
        .values({
          id: entryId,
          accountId: input.accountId,
          periodId: input.periodId,
          entryType: 'top_up_credit',
          direction: 'credit',
          amountMicrousd: input.amountMicrousd,
          currency: 'USD',
          sourceType: 'top_up_checkout',
          sourceId: input.sourceId,
          description: input.description ?? 'Credit top-up',
        })
        .onConflictDoNothing()
        .returning({ id: billingLedgerEntries.id });

      // Only update period balance if the ledger entry was actually inserted (not a duplicate)
      if (inserted.length > 0) {
        await tx
          .update(billingPeriods)
          .set({
            balanceMicrousd: sql`${billingPeriods.balanceMicrousd} + ${input.amountMicrousd}`,
            updatedAt: new Date(),
          })
          .where(eq(billingPeriods.id, input.periodId));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Read models
  // ---------------------------------------------------------------------------

  async getUsageSummary(accountId: string, _filters?: UsageSummaryFilters) {
    const [account] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId))
      .limit(1);

    if (!account) return null;

    const [period] = await this.db
      .select()
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.accountId, accountId),
          eq(billingPeriods.status, 'open'),
        ),
      )
      .orderBy(desc(billingPeriods.periodStart))
      .limit(1);

    return { account, period: period ?? null };
  }

  async getByMeterBreakdown(accountId: string, filters?: { periodId?: string; from?: Date; to?: Date }) {
    const conditions = [eq(billingUsageEvents.accountId, accountId)];
    if (filters?.from) conditions.push(gte(billingUsageEvents.occurredAt, filters.from));
    if (filters?.to) conditions.push(lte(billingUsageEvents.occurredAt, filters.to));

    if (filters?.periodId) {
      const [period] = await this.db
        .select({ periodStart: billingPeriods.periodStart, periodEnd: billingPeriods.periodEnd })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, filters.periodId))
        .limit(1);
      if (period) {
        conditions.push(gte(billingUsageEvents.occurredAt, period.periodStart));
        conditions.push(lte(billingUsageEvents.occurredAt, period.periodEnd));
      }
    }

    const rows = await this.db
      .select({
        meterKey: billingUsageEvents.meterKey,
        totalQuantity: sql<number>`sum(${billingUsageEvents.quantity})`,
        chargeMicrousd: sql<number>`coalesce(sum(case when ${billingLedgerEntries.entryType} = 'usage_charge' and ${billingLedgerEntries.sourceType} = 'usage_event' then ${billingLedgerEntries.amountMicrousd} else 0 end), 0)`,
      })
      .from(billingUsageEvents)
      .leftJoin(
        billingLedgerEntries,
        and(
          eq(billingLedgerEntries.sourceType, 'usage_event'),
          eq(billingLedgerEntries.sourceId, billingUsageEvents.id),
          eq(billingLedgerEntries.accountId, accountId),
        ),
      )
      .where(and(...conditions))
      .groupBy(billingUsageEvents.meterKey);

    return rows;
  }

  async getByAgentBreakdown(accountId: string, filters?: { periodId?: string; from?: Date; to?: Date }) {
    const conditions = [eq(billingUsageEvents.accountId, accountId)];
    if (filters?.from) conditions.push(gte(billingUsageEvents.occurredAt, filters.from));
    if (filters?.to) conditions.push(lte(billingUsageEvents.occurredAt, filters.to));

    if (filters?.periodId) {
      const [period] = await this.db
        .select({ periodStart: billingPeriods.periodStart, periodEnd: billingPeriods.periodEnd })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, filters.periodId))
        .limit(1);
      if (period) {
        conditions.push(gte(billingUsageEvents.occurredAt, period.periodStart));
        conditions.push(lte(billingUsageEvents.occurredAt, period.periodEnd));
      }
    }

    const rows = await this.db
      .select({
        agentId: billingUsageEvents.agentId,
        agentName: agents.name,
        totalQuantity: sql<number>`sum(${billingUsageEvents.quantity})`,
        chargeMicrousd: sql<number>`coalesce(sum(case when ${billingLedgerEntries.entryType} = 'usage_charge' and ${billingLedgerEntries.sourceType} = 'usage_event' then ${billingLedgerEntries.amountMicrousd} else 0 end), 0)`,
      })
      .from(billingUsageEvents)
      .leftJoin(agents, eq(billingUsageEvents.agentId, agents.id))
      .leftJoin(
        billingLedgerEntries,
        and(
          eq(billingLedgerEntries.sourceType, 'usage_event'),
          eq(billingLedgerEntries.sourceId, billingUsageEvents.id),
          eq(billingLedgerEntries.accountId, accountId),
        ),
      )
      .where(and(...conditions))
      .groupBy(billingUsageEvents.agentId, agents.name);

    return rows;
  }

  async listUsageEvents(accountId: string, filters: UsageEventFilters = {}) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const conditions = [eq(billingUsageEvents.accountId, accountId)];
    if (filters.meterKey) conditions.push(eq(billingUsageEvents.meterKey, filters.meterKey));
    if (filters.agentId) conditions.push(eq(billingUsageEvents.agentId, filters.agentId));
    if (filters.sessionId) conditions.push(eq(billingUsageEvents.sessionId, filters.sessionId));
    if (filters.from) conditions.push(gte(billingUsageEvents.occurredAt, filters.from));
    if (filters.to) conditions.push(lte(billingUsageEvents.occurredAt, filters.to));

    if (filters.periodId) {
      const [period] = await this.db
        .select({ periodStart: billingPeriods.periodStart, periodEnd: billingPeriods.periodEnd })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, filters.periodId))
        .limit(1);

      if (period) {
        conditions.push(gte(billingUsageEvents.occurredAt, period.periodStart));
        conditions.push(lte(billingUsageEvents.occurredAt, period.periodEnd));
      }
    }

    const rows = await this.db
      .select({
        event: billingUsageEvents,
        agentName: agents.name,
        sessionStatus: agentRuntimeSessions.status,
        chargeMicrousd: sql<number>`coalesce(sum(case when ${billingLedgerEntries.entryType} = 'usage_charge' and ${billingLedgerEntries.sourceType} = 'usage_event' then ${billingLedgerEntries.amountMicrousd} else 0 end), 0)`,
        currency: sql<string>`coalesce(max(${billingLedgerEntries.currency}), 'USD')`,
      })
      .from(billingUsageEvents)
      .leftJoin(agents, eq(billingUsageEvents.agentId, agents.id))
      .leftJoin(agentRuntimeSessions, eq(billingUsageEvents.sessionId, agentRuntimeSessions.id))
      .leftJoin(
        billingLedgerEntries,
        and(
          eq(billingLedgerEntries.sourceType, 'usage_event'),
          eq(billingLedgerEntries.sourceId, billingUsageEvents.id),
          eq(billingLedgerEntries.accountId, accountId),
        ),
      )
      .where(and(...conditions))
      .groupBy(billingUsageEvents.id, agents.name, agentRuntimeSessions.status)
      .orderBy(desc(billingUsageEvents.occurredAt))
      .limit(limit)
      .offset(offset);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(billingUsageEvents)
      .where(and(...conditions));

    return { rows, total: countRows[0]?.count ?? 0, limit, offset };
  }

  async listPeriods(accountId: string): Promise<typeof billingPeriods.$inferSelect[]> {
    return this.db
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.accountId, accountId))
      .orderBy(desc(billingPeriods.periodStart));
  }

  async getAccountByUserId(userId: string): Promise<BillingAccountRow | null> {
    const [row] = await this.db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId))
      .limit(1);

    return (row as BillingAccountRow) ?? null;
  }

  /** Re-evaluate account spend state from current open-period balance and caps */
  async recomputeSpendState(accountId: string): Promise<AccountStatus> {
    const [period] = await this.db
      .select({
        balanceMicrousd: billingPeriods.balanceMicrousd,
        usageChargeMicrousd: billingPeriods.usageChargeMicrousd,
        includedCreditMicrousd: billingPeriods.includedCreditMicrousd,
        hardCapMicrousd: billingPeriods.hardCapMicrousd,
        softCapMicrousd: billingPeriods.softCapMicrousd,
      })
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.accountId, accountId),
          eq(billingPeriods.status, 'open'),
        ),
      )
      .orderBy(desc(billingPeriods.periodStart))
      .limit(1);

    if (!period) return 'active';

    const newStatus = computeSpendStatus(period);
    await this.updateAccountStatus(accountId, newStatus);
    return newStatus;
  }

  // ---------------------------------------------------------------------------
  // LLM pricing snapshots
  // ---------------------------------------------------------------------------

  /** Get the active pricing snapshot for a provider, or null if none exists. */
  async getLatestPricingSnapshot(provider: string): Promise<typeof llmPricingSnapshots.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(llmPricingSnapshots)
      .where(
        and(
          eq(llmPricingSnapshots.provider, provider),
          eq(llmPricingSnapshots.isActive, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Upsert a new pricing snapshot. Sets the new row active, deactivates previous rows for the same provider. */
  async upsertPricingSnapshot(params: {
    id: string;
    provider: string;
    fetchedAt: Date | null;
    models: Record<string, { inputUsdPerM: number; outputUsdPerM: number; reasoningUsdPerM?: number }>;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(llmPricingSnapshots)
        .set({ isActive: false })
        .where(
          and(
            eq(llmPricingSnapshots.provider, params.provider),
            eq(llmPricingSnapshots.isActive, true),
          ),
        );
      await tx
        .insert(llmPricingSnapshots)
        .values({
          id: params.id,
          provider: params.provider,
          fetchedAt: params.fetchedAt,
          models: params.models,
          isActive: true,
        })
        .onConflictDoNothing();
    });
  }
}

// ---------------------------------------------------------------------------
// Spend status computation
// ---------------------------------------------------------------------------

/**
 * Determine account spend status from period state.
 *
 * Uses net out-of-pocket spend: max(0, -balanceMicrousd).
 * Balance = includedCredit + topUps - usageCharge, so top-ups increase balance
 * and can unblock a hard-limited account within the same period.
 *
 * Caps represent maximum allowed net out-of-pocket beyond included credits.
 */
function computeSpendStatus(period: {
  balanceMicrousd: number;
  hardCapMicrousd: number | null;
  softCapMicrousd: number | null;
  includedCreditMicrousd: number;
  usageChargeMicrousd: number;
}): AccountStatus {
  // Net out-of-pocket spend beyond included credits and top-ups
  const netOutOfPocket = Math.max(0, -period.balanceMicrousd);

  if (period.hardCapMicrousd != null && netOutOfPocket >= period.hardCapMicrousd) {
    return 'hard_limited';
  }
  if (period.softCapMicrousd != null && netOutOfPocket >= period.softCapMicrousd) {
    return 'soft_limited';
  }
  return 'active';
}

// ---------------------------------------------------------------------------
// Rating helper
// ---------------------------------------------------------------------------

function computeCharge(
  event: InsertUsageEvent,
  rateCardItems: typeof billingRateCardItems.$inferSelect[],
): number {
  // Find the most specific matching rate card item
  const matching = rateCardItems.filter((item) => {
    if (item.meterKey !== event.meterKey) return false;
    if (item.provider != null && item.provider !== event.provider) return false;
    if (item.modelPattern != null && event.model != null) {
      // Simple glob: trailing * wildcard only
      const pattern = item.modelPattern;
      if (pattern.endsWith('*')) {
        if (!event.model.startsWith(pattern.slice(0, -1))) return false;
      } else if (pattern !== event.model) {
        return false;
      }
    }
    return true;
  });

  if (matching.length === 0) return 0;

  // Most specific item: prefer provider+model match over provider-only, over catch-all
  const best = matching.sort((a, b) => {
    const scoreA = (a.provider != null ? 1 : 0) + (a.modelPattern != null ? 1 : 0);
    const scoreB = (b.provider != null ? 1 : 0) + (b.modelPattern != null ? 1 : 0);
    return scoreB - scoreA;
  })[0];

  if (!best) return 0;

  const rawCharge = (event.quantity * best.priceMicrousd) / best.perUnit;
  let charge = 0;
  if (best.roundingMode === 'down') {
    charge = Math.floor(rawCharge);
  } else if (best.roundingMode === 'nearest') {
    charge = Math.round(rawCharge);
  } else {
    charge = Math.ceil(rawCharge);
  }

  if (best.minimumChargeMicrousd != null && charge < best.minimumChargeMicrousd) {
    charge = best.minimumChargeMicrousd;
  }

  return charge;
}
