import type { BillingProvider } from '@herobids/domain';

// --- Port interface ---

export interface CheckoutParams {
  userId: string;
  email: string;
  planId: string;
  /** Specific provider price/product ID to use. When omitted the adapter falls back to the first configured entry for the plan. */
  priceId?: string;
  /** Billing interval hint — used by adapters when priceId is absent, and preserved through provider failover so the fallback picks the same interval variant. */
  interval?: 'month' | 'year';
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface PortalParams {
  customerId: string;
  returnUrl: string;
}

export interface PaymentProvider {
  readonly name: BillingProvider;
  createCheckoutUrl(params: CheckoutParams): Promise<string>;
  createPortalUrl(params: PortalParams): Promise<string>;
  cancelSubscription(externalSubscriptionId: string, atPeriodEnd?: boolean): Promise<void>;
  upgradeSubscription(externalSubscriptionId: string, newProductOrPriceId: string, prorate: boolean): Promise<void>;
  verifyWebhook(payload: string, headers: Record<string, string>): NormalizedWebhookEvent;
}

// --- Normalized webhook event ---

export type NormalizedEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'payment.failed';

export interface NormalizedWebhookEvent {
  id: string;
  type: NormalizedEventType;
  provider: BillingProvider;
  subscriptionId: string;
  customerId: string;
  productOrPriceId: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEnd: Date | null;
  metadata: Record<string, string>;
  createdAt: Date;
}

// --- Error types ---

/**
 * Thrown when a webhook payload carries an event type the provider does not handle.
 * Webhook endpoints should respond 200 and skip processing — retries are not useful.
 */
export class UnknownWebhookEventTypeError extends Error {
  constructor(public readonly eventType: string) {
    super(`Unhandled webhook event type: '${eventType}'`);
    this.name = 'UnknownWebhookEventTypeError';
  }
}

/**
 * Thrown when a payment provider is unreachable or returns a retryable error (5xx, network).
 * The PaymentProviderManager uses this to trigger fallback.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly provider: BillingProvider,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderUnavailableError';
  }
}
