import type { BillingConfig, PlansConfig } from '@herobids/domain';
import type { BillingRepository } from '@herobids/db';
import { UsageBillingRepository } from '@herobids/db';
import type { NormalizedWebhookEvent } from './provider-port.js';

/**
 * Entitlement sync — converts normalized provider events into internal plan transitions.
 *
 * The rules:
 * - active / trialing → map product/price ID to internal plan ID (upgrade or maintain)
 * - canceled / unpaid / past_due / incomplete_expired → downgrade to default (free) plan
 * - Idempotent: skips if the event has already been processed
 * - Monotonic: uses lastEventAt to avoid out-of-order regressions
 */
export class EntitlementSync {
  constructor(
    private readonly billingRepo: BillingRepository,
    private readonly config: BillingConfig,
    private readonly defaultPlanId: string,
    private readonly usageBillingRepo?: UsageBillingRepository,
    private readonly defaultRateCardName?: string,
    private readonly plansConfig?: PlansConfig,
  ) {}

  /**
   * Process a normalized webhook event and sync entitlements if applicable.
   * Returns true if the event was processed, false if it was a duplicate or unhandled type.
   */
  async processEvent(event: NormalizedWebhookEvent): Promise<{ processed: boolean; error?: string }> {
    // Namespace by provider so identical event ID strings from different providers cannot collide.
    const dedupeKey = `${event.provider}:${event.id}`;
    const alreadyProcessed = await this.billingRepo.isEventProcessed(dedupeKey);
    if (alreadyProcessed) {
      return { processed: false };
    }

    try {
      const handled = await this.handleEvent(event);
      if (handled) {
        await this.billingRepo.recordEventProcessed(dedupeKey, `${event.provider}.${event.type}`);
      }
      return { processed: handled };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.billingRepo.recordEventFailed(dedupeKey, `${event.provider}.${event.type}`, errorMsg);
      return { processed: false, error: errorMsg };
    }
  }

  private async handleEvent(event: NormalizedWebhookEvent): Promise<boolean> {
    switch (event.type) {
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'payment.failed':
        return this.handleSubscriptionChange(event);
      case 'top_up.completed':
        return this.handleTopUpCompleted(event);
      default:
        return false;
    }
  }

  private async handleTopUpCompleted(event: NormalizedWebhookEvent): Promise<boolean> {
    if (!this.usageBillingRepo) {
      return false;
    }

    const userId = event.metadata['referenceId'] ?? event.metadata['herobidsUserId'];
    const centsRaw = event.metadata['topUpCents'];
    const topUpCents = centsRaw ? Number.parseInt(centsRaw, 10) : Number.NaN;
    if (!userId || !Number.isFinite(topUpCents) || topUpCents <= 0) {
      throw new Error(`Invalid top-up webhook metadata for event ${event.id}`);
    }

    const planId = await this.usageBillingRepo.getUserPlanId(userId) ?? this.defaultPlanId;
    const planUsage = this.plansConfig?.plans[planId]?.usage;
    const planSoftCapMicrousd = planUsage?.softCapCents != null ? planUsage.softCapCents * 10_000 : null;
    const planHardCapMicrousd = planUsage?.hardCapCents != null ? planUsage.hardCapCents * 10_000 : null;

    const existingAccount = await this.usageBillingRepo.getAccountByUserId(userId);
    const account = await this.usageBillingRepo.getOrCreateBillingAccountForUser(userId, planId, {
      softCapMicrousd: existingAccount?.softCapMicrousd ?? planSoftCapMicrousd,
      hardCapMicrousd: existingAccount?.hardCapMicrousd ?? planHardCapMicrousd,
    });

    const rateCardName = this.defaultRateCardName ?? 'default';
    const activeRateCard = await this.usageBillingRepo.ensureActiveRateCard(rateCardName);

    const accountPlanUsage = this.plansConfig?.plans[account.activePlanId]?.usage;
    const includedCreditMicrousd = (accountPlanUsage?.includedCreditCents ?? 0) * 10_000;
    const effectiveSoftCapMicrousd = account.softCapMicrousd ?? planSoftCapMicrousd;
    const effectiveHardCapMicrousd = account.hardCapMicrousd ?? planHardCapMicrousd;

    const period = await this.usageBillingRepo.getOrCreateOpenPeriod(
      account.id,
      new Date(),
      account.activePlanId,
      activeRateCard.id,
      includedCreditMicrousd,
      effectiveSoftCapMicrousd,
      effectiveHardCapMicrousd,
    );

    await this.usageBillingRepo.openTopUpCreditFromWebhook({
      accountId: account.id,
      periodId: period.id,
      amountMicrousd: topUpCents * 10_000,
      sourceId: `${event.provider}:${event.id}`,
      description: event.metadata['topUpPackId']
        ? `Credit top-up (${event.metadata['topUpPackId']})`
        : 'Credit top-up',
    });
    await this.usageBillingRepo.recomputeSpendState(account.id);
    return true;
  }

  private async handleSubscriptionChange(event: NormalizedWebhookEvent): Promise<boolean> {
    const { provider, customerId, subscriptionId, productOrPriceId, status } = event;

    // Resolve internal plan ID from status and product/price ID
    const targetPlanId = this.resolvePlanFromStatus(status, productOrPriceId, provider);

    // Find the user via billing customer record
    const customer = await this.billingRepo.findCustomerByExternalId(customerId, provider);
    if (!customer) {
      // Try to link via metadata if available (Creem creates customers implicitly)
      const userId = event.metadata['referenceId'] ?? event.metadata['herobidsUserId'];
      if (userId) {
        await this.billingRepo.getOrCreateCustomer(userId, customerId, provider);
      } else {
        throw new Error(`No billing customer found for ${provider} customer ${customerId}`);
      }
    }

    const resolvedCustomer = customer ?? await this.billingRepo.findCustomerByExternalId(customerId, provider);
    if (!resolvedCustomer) {
      throw new Error(`No billing customer found for ${provider} customer ${customerId}`);
    }

    // Check monotonicity — don't regress if we've already applied a newer event
    const existingSub = await this.billingRepo.findSubscriptionByExternalId(subscriptionId, provider);
    if (existingSub?.lastEventAt) {
      if (event.createdAt <= existingSub.lastEventAt) {
        return false;
      }
    }

    await this.billingRepo.upsertSubscriptionAndSyncPlan(
      {
        userId: resolvedCustomer.userId,
        provider,
        externalCustomerId: customerId,
        externalSubscriptionId: subscriptionId,
        planId: targetPlanId,
        externalPriceOrProductId: productOrPriceId,
        status,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        canceledAt: event.canceledAt,
        trialEnd: event.trialEnd,
        lastEventAt: event.createdAt,
      },
      targetPlanId,
    );

    // Ensure a usage billing account exists so top-up packs and spend controls
    // are immediately available in the UI without waiting for agent activity.
    // The new plan's caps are applied to the account so the effective caps
    // reflect the upgrade (matching the worker's session-start reconciliation).
    // User-set caps are preserved: getOrCreateBillingAccountForUser only
    // overwrites when the caller passes a value, and we pass the plan caps only
    // when the account has no cap set (null).
    if (this.usageBillingRepo) {
      const planUsage = this.plansConfig?.plans[targetPlanId]?.usage;
      const planSoftCapMicrousd = planUsage?.softCapCents != null ? planUsage.softCapCents * 10_000 : null;
      const planHardCapMicrousd = planUsage?.hardCapCents != null ? planUsage.hardCapCents * 10_000 : null;

      const existingAccount = await this.usageBillingRepo.getAccountByUserId(resolvedCustomer.userId);

      const account = await this.usageBillingRepo.getOrCreateBillingAccountForUser(
        resolvedCustomer.userId,
        targetPlanId,
        {
          softCapMicrousd: this.resolveCapForUpgrade(existingAccount, 'softCapMicrousd', planSoftCapMicrousd),
          hardCapMicrousd: this.resolveCapForUpgrade(existingAccount, 'hardCapMicrousd', planHardCapMicrousd),
        },
      );

      // Reconcile the open billing period for the new plan so spend state
      // reflects the upgrade immediately (e.g. a free → starter upgrade adds
      // the starter included credit and moves the account out of hard_limited).
      // getOrCreateOpenPeriod only increases included credit (downgrades take
      // effect next period) and recomputes account status when credit increases.
      const accountPlanUsage = this.plansConfig?.plans[account.activePlanId]?.usage;
      const includedCreditMicrousd = (accountPlanUsage?.includedCreditCents ?? 0) * 10_000;
      const softCapMicrousd = account.softCapMicrousd
        ?? (accountPlanUsage?.softCapCents != null ? accountPlanUsage.softCapCents * 10_000 : null);
      const hardCapMicrousd = account.hardCapMicrousd
        ?? (accountPlanUsage?.hardCapCents != null ? accountPlanUsage.hardCapCents * 10_000 : null);

      const rateCardName = this.defaultRateCardName ?? 'default';
      const activeRateCard = await this.usageBillingRepo.ensureActiveRateCard(rateCardName);

      await this.usageBillingRepo.getOrCreateOpenPeriod(
        account.id,
        new Date(),
        account.activePlanId,
        activeRateCard.id,
        includedCreditMicrousd,
        softCapMicrousd,
        hardCapMicrousd,
      );
      await this.usageBillingRepo.recomputeSpendState(account.id);
    }

    return true;
  }

  /**
   * Decide the cap value to apply to the account on a plan change.
   *
   * There is no provenance field distinguishing user-set caps from plan-derived
   * caps, so we infer it: if the account's current cap is null or matches the
   * OLD plan's configured cap, it is treated as plan-derived and refreshed to
   * the new plan's cap. Otherwise it is treated as user-set and preserved
   * (returns undefined so getOrCreateBillingAccountForUser leaves it unchanged).
   */
  private resolveCapForUpgrade(
    existingAccount: { activePlanId?: string | null; softCapMicrousd?: number | null; hardCapMicrousd?: number | null } | null,
    capField: 'softCapMicrousd' | 'hardCapMicrousd',
    newPlanCapMicrousd: number | null,
  ): number | null | undefined {
    if (!existingAccount) {
      return newPlanCapMicrousd;
    }
    const oldPlanUsage = existingAccount.activePlanId
      ? this.plansConfig?.plans[existingAccount.activePlanId]?.usage
      : undefined;
    const centsField = capField === 'softCapMicrousd' ? 'softCapCents' : 'hardCapCents';
    const oldPlanCapMicrousd = oldPlanUsage?.[centsField] != null ? oldPlanUsage[centsField] * 10_000 : null;
    const currentCap = existingAccount[capField] ?? null;
    const isPlanDerived = currentCap == null || currentCap === oldPlanCapMicrousd;
    return isPlanDerived ? newPlanCapMicrousd : undefined;
  }

  /**
   * Resolve the internal plan ID from subscription status and the provider's price/product ID.
   * Active/trialing → look up plan from the appropriate provider mapping.
   * Any failure state → fall back to default (free) plan.
   */
  private resolvePlanFromStatus(status: string, productOrPriceId: string, provider: string): string {
    // scheduled_cancel is Creem's status for a subscription still active but set to cancel at period end.
    // Entitlements must be preserved until the period ends, just like 'active'.
    const activating = status === 'active' || status === 'trialing' || status === 'scheduled_cancel';

    if (!activating) {
      return this.defaultPlanId;
    }

    const resolved = this.resolvePlanIdFromProductOrPrice(productOrPriceId, provider);
    if (!resolved) {
      throw new Error(
        `Cannot resolve plan for active ${provider} subscription — unknown product/price ID '${productOrPriceId}'. Check billing config mappings.`,
      );
    }
    return resolved;
  }

  private resolvePlanIdFromProductOrPrice(id: string, provider: string): string | null {
    if (provider === 'stripe') {
      for (const [planId, prices] of Object.entries(this.config.stripe.planPrices)) {
        if (prices.some((p) => p.stripePriceId === id)) {
          return planId;
        }
      }
    } else if (provider === 'creem') {
      for (const [planId, products] of Object.entries(this.config.creem.planProducts)) {
        if (products.some((p) => p.creemProductId === id)) {
          return planId;
        }
      }
    } else if (provider === 'mock') {
      // Mock provider encodes planId directly: "mock_product_<planId>"
      const prefix = 'mock_product_';
      if (id.startsWith(prefix)) {
        return id.slice(prefix.length);
      }
    }
    return null;
  }
}

/**
 * Utility to resolve an internal plan ID from a Stripe price ID.
 * Used by billing routes to validate price IDs during checkout.
 */
export function resolvePlanIdFromPriceId(config: BillingConfig, priceId: string): string | null {
  for (const [planId, prices] of Object.entries(config.stripe.planPrices)) {
    if (prices.some((p) => p.stripePriceId === priceId)) {
      return planId;
    }
  }
  return null;
}

/**
 * Utility to resolve an internal plan ID from a Creem product ID.
 */
export function resolvePlanIdFromProductId(config: BillingConfig, productId: string): string | null {
  for (const [planId, products] of Object.entries(config.creem.planProducts)) {
    if (products.some((p) => p.creemProductId === productId)) {
      return planId;
    }
  }
  return null;
}
