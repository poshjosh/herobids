import crypto from 'node:crypto';
import type {
  PaymentProvider,
  CheckoutParams,
  PortalParams,
  NormalizedWebhookEvent,
} from './provider-port.js';

/**
 * Mock payment provider for local development.
 *
 * - Returns the success URL directly (no external redirect needed).
 * - Does not make any network calls.
 * - verifyWebhook is never called externally — the auto-fulfill logic
 *   in billing routes creates synthetic events directly.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async createCheckoutUrl(params: CheckoutParams): Promise<string> {
    return params.successUrl;
  }

  async createPortalUrl(params: PortalParams): Promise<string> {
    return params.returnUrl;
  }

  async cancelSubscription(_externalSubscriptionId: string, _atPeriodEnd?: boolean): Promise<void> {
    // No-op in mock
  }

  async upgradeSubscription(_externalSubscriptionId: string, _currentProductOrPriceId: string, _newProductOrPriceId: string, _prorate: boolean): Promise<void> {
    // No-op in mock
  }

  verifyWebhook(_payload: string, _headers: Record<string, string>): NormalizedWebhookEvent {
    throw new Error('MockProvider does not verify external webhooks');
  }

  /**
   * Create a synthetic subscription.created event for auto-fulfillment.
   */
  createSyntheticEvent(params: {
    userId: string;
    planId: string;
    productOrPriceId: string;
  }): NormalizedWebhookEvent {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    return {
      id: `mock_evt_${crypto.randomUUID()}`,
      type: 'subscription.created',
      provider: 'mock',
      subscriptionId: `mock_sub_${crypto.randomUUID()}`,
      customerId: `mock_cus_${params.userId}`,
      productOrPriceId: params.productOrPriceId,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: { referenceId: params.userId, planId: params.planId },
      createdAt: now,
    };
  }

  /**
   * Create a synthetic subscription.updated event for cancel-at-period-end.
   * Preserves existing period dates so the UI can show the correct end date.
   */
  createSyntheticCancelEvent(params: {
    subscriptionId: string;
    customerId: string;
    productOrPriceId: string;
    userId: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  }): NormalizedWebhookEvent {
    return {
      id: `mock_evt_${crypto.randomUUID()}`,
      type: 'subscription.updated',
      provider: 'mock',
      subscriptionId: params.subscriptionId,
      customerId: params.customerId,
      productOrPriceId: params.productOrPriceId,
      status: 'active',
      currentPeriodStart: params.currentPeriodStart,
      currentPeriodEnd: params.currentPeriodEnd,
      cancelAtPeriodEnd: true,
      canceledAt: null,
      trialEnd: null,
      metadata: { referenceId: params.userId },
      createdAt: new Date(),
    };
  }

  /**
   * Create a synthetic subscription.updated event for an immediate plan upgrade.
   */
  createSyntheticUpgradeEvent(params: {
    subscriptionId: string;
    customerId: string;
    newPlanId: string;
    userId: string;
  }): NormalizedWebhookEvent {
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    return {
      id: `mock_evt_${crypto.randomUUID()}`,
      type: 'subscription.updated',
      provider: 'mock',
      subscriptionId: params.subscriptionId,
      customerId: params.customerId,
      productOrPriceId: `mock_product_${params.newPlanId}`,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: { referenceId: params.userId },
      createdAt: now,
    };
  }

  createSyntheticTopUpEvent(params: {
    userId: string;
    packId: string;
    cents: number;
  }): NormalizedWebhookEvent {
    return {
      id: `mock_evt_${crypto.randomUUID()}`,
      type: 'top_up.completed',
      provider: 'mock',
      subscriptionId: '',
      customerId: `mock_cus_${params.userId}`,
      productOrPriceId: params.packId,
      status: 'paid',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {
        referenceId: params.userId,
        topUpPackId: params.packId,
        topUpCents: String(params.cents),
        checkoutKind: 'top_up',
      },
      createdAt: new Date(),
    };
  }
}
