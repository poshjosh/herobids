import type { BillingConfig } from '@herobids/domain';
import type { BillingRepository } from '@herobids/db';
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
      default:
        return false;
    }
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

    return true;
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
