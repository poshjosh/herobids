import { eq, and, desc, gte, lt, lte, sql } from 'drizzle-orm';
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

export interface LedgerEntryFilters {
  limit?: number;
  offset?: number;
  entryType?: string;
  direction?: 'credit' | 'debit';
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

export interface QuoteMeterChargeInput {
  rateCardId: string;
  meterKey: string;
  quantity: number;
}

export interface ReserveChargeInput {
  accountId: string;
  periodId: string;
  /** Quoted charge amount in microusd (from quoteMeterCharge) */
  amountMicrousd: number;
  /** Unique ID for the reservation ledger entry */
  reservationId: string;
  /** Human-readable description */
  description?: string;
}

export interface ReserveChargeResult {
  reservationLedgerEntryId: string;
  reservedAmountMicrousd: number;
}

export interface CaptureReservedChargeInput {
  accountId: string;
  periodId: string;
  rateCardId: string;
  /** The quoted amount to capture (should match reservation amount) */
  amountMicrousd: number;
  /** The request ID — used as usage event id AND idempotencyKey (R1) */
  requestId: string;
  userId: string;
  agentId: string;
  /** Meter key for the usage event */
  meterKey: string;
  /** Quantity for the usage event */
  quantity: number;
  /** Unit for the usage event */
  unit: string;
  /** The reservation ledger entry ID to link */
  reservationLedgerEntryId: string;
  /** Description for usage charge ledger entry */
  description?: string;
  /** Optional metadata for the usage event */
  metadata?: Record<string, unknown>;
}

export interface CaptureReservedChargeResult {
  usageEventId: string;
  captureLedgerEntryId: string;
  newSpendStatus: string;
}

export interface ReleaseReservedChargeInput {
  accountId: string;
  periodId: string;
  /** The quoted amount to release (should match reservation amount) */
  amountMicrousd: number;
  /** Unique ID for the release ledger entry */
  releaseId: string;
  /** The reservation ledger entry ID this release corresponds to */
  reservationLedgerEntryId: string;
  /** Description */
  description?: string;
}

export interface ReleaseReservedChargeResult {
  releaseLedgerEntryId: string;
}

export type AccountStatus = 'active' | 'soft_limited' | 'hard_limited' | 'suspended';

export interface CanSpendNowResult {
  canSpend: boolean;
  availableMicrousd: number;
  hardCapMicrousd: number | null;
  status: AccountStatus;
  reason: 'ok' | 'no_available_credit' | 'hard_limited' | 'suspended';
}

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
  meterKey: 'agent.runtime_ms' | 'assessment.request';
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

/**
 * Default rate card seed items used when no explicit items are passed to the constructor.
 *
 * LLM token rate cards (input/output/reasoning tokens) are NOT included here —
 * they are sourced dynamically from `llm_pricing_snapshots` at seed time
 * (see ADR 010: LLM Pricing Sourced from Database, Not Hardcoded).
 *
 * This default matches the Zod schema default in `UsageBillingConfigSchema.defaultRateCardItems`.
 */
const DEFAULT_RATE_CARD_ITEMS: DefaultRateCardSeedItem[] = [
  { meterKey: 'agent.runtime_ms', priceMicrousd: 100, perUnit: 60_000 },
  { meterKey: 'assessment.request', priceMicrousd: 200000, perUnit: 1 },
];

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class UsageBillingRepository {
  constructor(
    private readonly db: Database,
    private readonly rateCardItems: RateCardSeedItem[] = DEFAULT_RATE_CARD_ITEMS,
    private readonly providers?: ProvidersYaml,
    private readonly fallbackCacheReadPct?: number,
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

  /**
   * Check whether paid work is allowed right now for this billing account.
   *
   * Hard-cap rule: null cap = unlimited on the credit dimension.  When a
   * hard cap is set, paid work is blocked as soon as available credit
   * (balanceMicrousd - reservedMicrousd) reaches or goes below the hard-cap
   * balance threshold (availableMicrousd <= hardCapMicrousd).  A hard cap of
   * 0 blocks at $0.00; a negative hard cap allows overdraft up to that
   * amount.  In addition, the account status check blocks hard_limited and
   * suspended accounts.
   *
   * If no open period exists (fresh user), treat as canSpend: true.
   */
  async canSpendNow(accountId: string): Promise<CanSpendNowResult> {
    const [period] = await this.db
      .select({
        status: billingAccounts.status,
        balanceMicrousd: billingPeriods.balanceMicrousd,
        reservedMicrousd: billingPeriods.reservedMicrousd,
        hardCapMicrousd: billingPeriods.hardCapMicrousd,
      })
      .from(billingPeriods)
      .innerJoin(billingAccounts, eq(billingPeriods.accountId, billingAccounts.id))
      .where(
        and(
          eq(billingPeriods.accountId, accountId),
          eq(billingPeriods.status, 'open'),
        ),
      )
      .orderBy(desc(billingPeriods.periodStart))
      .limit(1);

    // No open period = fresh user, allow spending
    if (!period) {
      return {
        canSpend: true,
        availableMicrousd: 0,
        hardCapMicrousd: null,
        status: 'active',
        reason: 'ok',
      };
    }

    const availableMicrousd = period.balanceMicrousd - period.reservedMicrousd;

    if (period.status === 'hard_limited') {
      return { canSpend: false, availableMicrousd, hardCapMicrousd: period.hardCapMicrousd, status: 'hard_limited', reason: 'hard_limited' };
    }
    if (period.status === 'suspended') {
      return { canSpend: false, availableMicrousd, hardCapMicrousd: period.hardCapMicrousd, status: 'suspended', reason: 'suspended' };
    }
    if (period.status !== 'active' && period.status !== 'soft_limited') {
      console.warn(
        `[canSpendNow] Unknown account status "${period.status}" for account ${accountId}, blocking conservatively`,
      );
      return { canSpend: false, availableMicrousd, hardCapMicrousd: period.hardCapMicrousd, status: 'hard_limited', reason: 'hard_limited' };
    }
    // null cap → unlimited on the credit dimension.
    // set cap → block when available credit reaches or falls below the hard-cap balance threshold.
    // A negative hardCap means overdraft is allowed up to that amount.
    if (period.hardCapMicrousd != null && availableMicrousd <= period.hardCapMicrousd) {
      return { canSpend: false, availableMicrousd, hardCapMicrousd: period.hardCapMicrousd, status: period.status as AccountStatus, reason: 'no_available_credit' };
    }

    return { canSpend: true, availableMicrousd, hardCapMicrousd: period.hardCapMicrousd, status: period.status as AccountStatus, reason: 'ok' };
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
          // Reconcile the existing open period against the caller's intent.
          //
          // Included credit is reconciled "increase only": when the current plan
          // grants more than the period was opened with (e.g. free → starter
          // mid-period), the period is updated in-place with a delta ledger entry.
          // Downgrades take effect next period. planIdSnapshot is NOT updated —
          // it stays frozen as the plan that opened the period.
          //
          // Caps are reconciled independently of credit: the period's cap fields
          // are refreshed to the caller's effective caps whenever they differ, so
          // spend-state enforcement reflects the current plan even on a cap-only
          // change (computeSpendStatus reads caps from the period, not the account).
          // See docs/bug-reports/2026/08/03/001-billing-period-not-updated-on-plan-change.md.
          const creditIncreased = includedCreditMicrousd > existing.includedCreditMicrousd;
          const capsChanged = (softCapMicrousd ?? null) !== (existing.softCapMicrousd ?? null)
            || (hardCapMicrousd ?? null) !== (existing.hardCapMicrousd ?? null);

          if (creditIncreased || capsChanged) {
            const deltaCredit = creditIncreased
              ? includedCreditMicrousd - existing.includedCreditMicrousd
              : 0;
            const reconciledAt = new Date();

            const setClause: Record<string, unknown> = {
              updatedAt: reconciledAt,
            };
            if (creditIncreased) {
              setClause['includedCreditMicrousd'] = includedCreditMicrousd;
              setClause['balanceMicrousd'] = sql`${billingPeriods.balanceMicrousd} + ${deltaCredit}`;
            }
            if (capsChanged) {
              setClause['softCapMicrousd'] = softCapMicrousd ?? null;
              setClause['hardCapMicrousd'] = hardCapMicrousd ?? null;
            }

            // Conditional update makes the reconciliation idempotent under
            // concurrent callers: only the first stale reader can advance the
            // stored included credit, and later callers re-read the reconciled
            // row instead of applying the delta again.
            const [updatedPeriod] = await tx
              .update(billingPeriods)
              .set(setClause)
              .where(
                and(
                  eq(billingPeriods.id, existing.id),
                  creditIncreased
                    ? lt(billingPeriods.includedCreditMicrousd, includedCreditMicrousd)
                    : eq(billingPeriods.id, existing.id),
                ),
              )
              .returning();

            if (!updatedPeriod) {
              const [refetched] = await tx
                .select()
                .from(billingPeriods)
                .where(eq(billingPeriods.id, existing.id))
                .limit(1);

              if (!refetched) {
                throw new Error(`Failed to re-read billing period ${existing.id} after reconciliation race`);
              }

              return refetched;
            }

            // Recompute account spend status — the balance increase from the
            // upgrade may have moved the account out of hard_limited/soft_limited.
            const newStatus = computeSpendStatus(updatedPeriod);
            await tx
              .update(billingAccounts)
              .set({ status: newStatus, lastEvaluatedAt: reconciledAt, updatedAt: reconciledAt })
              .where(eq(billingAccounts.id, accountId));

            // Only credit increases produce an audit entry; cap-only refreshes
            // are idempotent and need no ledger record.
            if (creditIncreased) {
              // Unique sourceId per upgrade so multiple upgrades in one period
              // each produce their own audit entry — includes credit amount so
              // even same-plan credit changes (operator config update) are distinct.
              const adjSourceId = `${existing.id}_${planIdSnapshot}_${includedCreditMicrousd}`;
              const adjId = `led_plan_change_${adjSourceId}`;
              await tx
                .insert(billingLedgerEntries)
                .values({
                  id: adjId,
                  accountId,
                  periodId: existing.id,
                  entryType: 'plan_change_adjustment',
                  direction: 'credit',
                  amountMicrousd: deltaCredit,
                  currency: 'USD',
                  sourceType: 'plan_change',
                  sourceId: adjSourceId,
                  description: `Plan upgrade: included credit adjusted from ${existing.includedCreditMicrousd} → ${includedCreditMicrousd} µUSD (${existing.planIdSnapshot} → ${planIdSnapshot})`,
                })
                .onConflictDoNothing();
            }

            // planIdSnapshot is intentionally NOT updated — it stays frozen
            // as the plan that opened the period.
            return updatedPeriod;
          }

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
        const items = getLlmModelRateCardItems(providerId, snapshot.models as Record<string, Partial<ModelPricing>>, {
          fallbackCacheReadPct: this.fallbackCacheReadPct,
        });
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

  async listLedgerEntries(
    accountId: string,
    filters: LedgerEntryFilters = {},
  ): Promise<{ rows: typeof billingLedgerEntries.$inferSelect[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const conditions = [eq(billingLedgerEntries.accountId, accountId)];
    if (filters.entryType) conditions.push(eq(billingLedgerEntries.entryType, filters.entryType));
    if (filters.direction) conditions.push(eq(billingLedgerEntries.direction, filters.direction));
    if (filters.from) conditions.push(gte(billingLedgerEntries.createdAt, filters.from));
    if (filters.to) conditions.push(lte(billingLedgerEntries.createdAt, filters.to));

    if (filters.periodId) {
      const [period] = await this.db
        .select({ periodStart: billingPeriods.periodStart, periodEnd: billingPeriods.periodEnd })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, filters.periodId))
        .limit(1);

      if (period) {
        conditions.push(gte(billingLedgerEntries.createdAt, period.periodStart));
        conditions.push(lte(billingLedgerEntries.createdAt, period.periodEnd));
      }
    }

    const rows = await this.db
      .select()
      .from(billingLedgerEntries)
      .where(and(...conditions))
      .orderBy(desc(billingLedgerEntries.createdAt))
      .limit(limit)
      .offset(offset);

    const countRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(billingLedgerEntries)
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

  /**
   * Quote a charge for a specific meter without mutating any state.
   * Looks up the rate card item matching the given meter key and returns
   * the microusd charge for the given quantity.
   */
  async quoteMeterCharge(input: QuoteMeterChargeInput): Promise<number> {
    const items = await this.getRateCardItems(input.rateCardId);
    const item = items.find((i) => i.meterKey === input.meterKey);
    if (!item) {
      throw new Error(`No rate card item found for meter '${input.meterKey}' in rate card ${input.rateCardId}`);
    }
    // Fixed-price meter: priceMicrousd per perUnit, so charge = priceMicrousd * (quantity / perUnit)
    return Math.ceil((item.priceMicrousd * input.quantity) / item.perUnit);
  }

  /**
   * Reserve credit for an assessment request.
   *
   * Locks the open period row with SELECT FOR UPDATE (R6), validates account
   * status (blocks hard_limited/suspended), checks available credit against
   * the hard-cap balance threshold (null cap = unlimited, set cap = blocks
   * when post-reservation available credit reaches or goes below the
   * threshold), creates a reservation ledger entry, and increments
   * reserved_microusd.
   */
  async reserveCharge(input: ReserveChargeInput): Promise<ReserveChargeResult> {
    return this.db.transaction(async (tx) => {
      // Lock the period row for update (R6)
      const [period] = await tx
        .select({
          status: billingAccounts.status,
          balanceMicrousd: billingPeriods.balanceMicrousd,
          reservedMicrousd: billingPeriods.reservedMicrousd,
          hardCapMicrousd: billingPeriods.hardCapMicrousd,
        })
        .from(billingPeriods)
        .innerJoin(billingAccounts, eq(billingPeriods.accountId, billingAccounts.id))
        .where(
          and(
            eq(billingPeriods.id, input.periodId),
            eq(billingPeriods.status, 'open'),
          ),
        )
        .for('update')
        .limit(1);

      if (!period) {
        throw new Error(`Open period ${input.periodId} not found`);
      }

      // Block hard_limited and suspended accounts (R8)
      if (period.status === 'hard_limited') {
        throw Object.assign(new Error('Account is hard-limited'), { code: 'billing.limit_exceeded' });
      }
      if (period.status === 'suspended') {
        throw Object.assign(new Error('Account is suspended'), { code: 'billing.account_suspended' });
      }

      // Check available credit against hard-cap boundary
      const availableMicrousd = period.balanceMicrousd - period.reservedMicrousd;
      const postReservationAvailableMicrousd = availableMicrousd - input.amountMicrousd;

      if (
        period.hardCapMicrousd != null &&
        postReservationAvailableMicrousd <= period.hardCapMicrousd
      ) {
        throw Object.assign(
          new Error(
            `Insufficient credit: available ${availableMicrousd}, required ${input.amountMicrousd}, hardCap ${period.hardCapMicrousd}`,
          ),
          { code: 'billing.insufficient_credit' },
        );
      }

      // Create reservation ledger entry
      await tx
        .insert(billingLedgerEntries)
        .values({
          id: input.reservationId,
          accountId: input.accountId,
          periodId: input.periodId,
          entryType: 'reservation',
          direction: 'debit',
          amountMicrousd: input.amountMicrousd,
          currency: 'USD',
          sourceType: 'assessment_request',
          description: input.description ?? 'Assessment request reservation',
        })
        .onConflictDoNothing();

      // Increment reserved_microusd
      await tx
        .update(billingPeriods)
        .set({
          reservedMicrousd: sql`${billingPeriods.reservedMicrousd} + ${input.amountMicrousd}`,
          updatedAt: new Date(),
        })
        .where(eq(billingPeriods.id, input.periodId));

      return {
        reservationLedgerEntryId: input.reservationId,
        reservedAmountMicrousd: input.amountMicrousd,
      };
    });
  }

  /**
   * Capture a reserved assessment charge.
   *
   * Creates one usage event (idempotencyKey = requestId per R1), one
   * usage_charge ledger entry, decrements reserved_microusd, updates period
   * totals, and recomputes spend state — all in one transaction.
   * Reuses the same rating + spend-state recomputation as recordAndRateUsageBatch (R5).
   */
  async captureReservedAssessmentCharge(
    input: CaptureReservedChargeInput,
  ): Promise<CaptureReservedChargeResult> {
    return this.db.transaction(async (tx) => {
      // Create usage event keyed on requestId (R1)
      const usageEventId = input.requestId;
      await tx
        .insert(billingUsageEvents)
        .values({
          id: usageEventId,
          accountId: input.accountId,
          userId: input.userId,
          agentId: input.agentId,
          sourceType: 'assessment_request',
          meterKey: input.meterKey,
          quantity: input.quantity,
          unit: input.unit,
          idempotencyKey: input.requestId, // R1: per-attempt request id, not caller key
          occurredAt: new Date(),
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing();

      // Create usage_charge ledger entry
      const captureLedgerEntryId = `led_${usageEventId}`;
      await tx
        .insert(billingLedgerEntries)
        .values({
          id: captureLedgerEntryId,
          accountId: input.accountId,
          periodId: input.periodId,
          entryType: 'usage_charge',
          direction: 'debit',
          amountMicrousd: input.amountMicrousd,
          currency: 'USD',
          sourceType: 'usage_event',
          sourceId: usageEventId,
          description: input.description ?? `${input.meterKey} × ${input.quantity}`,
        })
        .onConflictDoNothing();

      // Decrement reserved_microusd and update period totals (R5)
      await tx
        .update(billingPeriods)
        .set({
          reservedMicrousd: sql`GREATEST(${billingPeriods.reservedMicrousd} - ${input.amountMicrousd}, 0)`,
          usageChargeMicrousd: sql`${billingPeriods.usageChargeMicrousd} + ${input.amountMicrousd}`,
          creditAppliedMicrousd: sql`${billingPeriods.creditAppliedMicrousd} + LEAST(${input.amountMicrousd}, GREATEST(${billingPeriods.balanceMicrousd}, 0))`,
          balanceMicrousd: sql`${billingPeriods.balanceMicrousd} - ${input.amountMicrousd}`,
          updatedAt: new Date(),
        })
        .where(eq(billingPeriods.id, input.periodId));

      // Recompute spend state (R5)
      const [period] = await tx
        .select({
          balanceMicrousd: billingPeriods.balanceMicrousd,
          hardCapMicrousd: billingPeriods.hardCapMicrousd,
          softCapMicrousd: billingPeriods.softCapMicrousd,
          includedCreditMicrousd: billingPeriods.includedCreditMicrousd,
          usageChargeMicrousd: billingPeriods.usageChargeMicrousd,
        })
        .from(billingPeriods)
        .where(eq(billingPeriods.id, input.periodId))
        .limit(1);

      let newSpendStatus = 'active';
      if (period) {
        newSpendStatus = computeSpendStatus(period);
        await tx
          .update(billingAccounts)
          .set({ status: newSpendStatus, lastEvaluatedAt: new Date(), updatedAt: new Date() })
          .where(eq(billingAccounts.id, input.accountId));
      }

      return {
        usageEventId,
        captureLedgerEntryId,
        newSpendStatus,
      };
    });
  }

  /**
   * Release a reserved charge without capturing it (e.g., after provider_failed).
   * Creates a reservation_release ledger entry and decrements reserved_microusd.
   * Does NOT create a usage event or usage charge.
   */
  async releaseReservedCharge(
    input: ReleaseReservedChargeInput,
  ): Promise<ReleaseReservedChargeResult> {
    return this.db.transaction(async (tx) => {
      // Create reservation_release ledger entry
      await tx
        .insert(billingLedgerEntries)
        .values({
          id: input.releaseId,
          accountId: input.accountId,
          periodId: input.periodId,
          entryType: 'reservation_release',
          direction: 'credit',
          amountMicrousd: input.amountMicrousd,
          currency: 'USD',
          sourceType: 'assessment_request',
          sourceId: input.reservationLedgerEntryId,
          description: input.description ?? 'Assessment request reservation release',
        })
        .onConflictDoNothing();

      // Decrement reserved_microusd
      await tx
        .update(billingPeriods)
        .set({
          reservedMicrousd: sql`GREATEST(${billingPeriods.reservedMicrousd} - ${input.amountMicrousd}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(billingPeriods.id, input.periodId));

      return {
        releaseLedgerEntryId: input.releaseId,
      };
    });
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
    models: Record<string, { inputUsdPerM: number; outputUsdPerM: number; reasoningUsdPerM?: number; cacheReadUsdPerM?: number }>;
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
 * Caps represent balance thresholds (not overspend amounts):
 * - softCapMicrousd: warn when balance drops to this level (null = no warning)
 * - hardCapMicrousd: block when balance drops to this level (null = no limit;
 *   negative = allow overdraft up to that amount)
 *
 * Examples with includedCredit = $20 (2 000 000 microusd):
 *   softCap=500 000 ($5)  hardCap=0        → warn at $5 left,  block at $0
 *   softCap=500 000 ($5)  hardCap=-200 000  → warn at $5 left,  block at -$2
 *   softCap=0            hardCap=0        → warn+block at $0 (free plan)
 */
export function computeSpendStatus(period: {
  balanceMicrousd: number;
  hardCapMicrousd: number | null;
  softCapMicrousd: number | null;
  includedCreditMicrousd: number;
  usageChargeMicrousd: number;
}): AccountStatus {
  // hardCap check first — when both caps are hit, hard_limited takes priority
  if (period.hardCapMicrousd != null && period.balanceMicrousd <= period.hardCapMicrousd) {
    return 'hard_limited';
  }
  if (period.softCapMicrousd != null && period.balanceMicrousd <= period.softCapMicrousd) {
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
  const findMatching = (modelId: string | null | undefined) =>
    rateCardItems.filter((item) => {
      if (item.meterKey !== event.meterKey) return false;
      if (item.provider != null && item.provider !== event.provider) return false;
      if (item.modelPattern != null) {
        // A model-specific item requires the event to carry a model ID.
        if (modelId == null) return false;
        // Simple glob: trailing * wildcard only
        const pattern = item.modelPattern;
        if (pattern.endsWith('*')) {
          if (!modelId.startsWith(pattern.slice(0, -1))) return false;
        } else if (pattern !== modelId) {
          return false;
        }
      }
      return true;
    });

  // First try the exact model ID from the event.
  // If the exact pass yields no model-specific winner and the model looks like
  // a provider-pinned dated variant (e.g. "deepseek/deepseek-v4-flash-20260423"),
  // retry after stripping the trailing date suffix so a catch-all item does not
  // shadow a more-specific undated rate card entry.
  // We only promote the stripped result when it contains at least one
  // model-specific item, preserving precedence of genuine exact matches.
  let matching = findMatching(event.model);
  const hasModelSpecificMatch = matching.some((item) => item.modelPattern != null);
  if (!hasModelSpecificMatch && event.model != null) {
    const stripped = event.model.replace(/-\d{8}$/, '');
    if (stripped !== event.model) {
      const strippedMatching = findMatching(stripped);
      if (strippedMatching.some((item) => item.modelPattern != null)) {
        matching = strippedMatching;
      }
    }
  }

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
