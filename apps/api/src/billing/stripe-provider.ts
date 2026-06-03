import type { StripeConfig } from '@herobids/domain';
import type {
  PaymentProvider,
  CheckoutParams,
  PortalParams,
  NormalizedWebhookEvent,
} from './provider-port.js';
import { ProviderUnavailableError, UnknownWebhookEventTypeError } from './provider-port.js';
import {
  StripeClient,
  StripeNetworkError,
  type StripeEvent,
  type StripeSubscription,
} from './stripe-client.js';
import type { BillingRepository } from '@herobids/db';

/**
 * Stripe payment provider adapter implementing the PaymentProvider port.
 * Wraps the raw StripeClient with the normalized interface.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly client: StripeClient;

  constructor(
    private readonly stripeConfig: StripeConfig,
    private readonly billingRepo: BillingRepository,
  ) {
    this.client = new StripeClient(stripeConfig);
  }

  async createCheckoutUrl(params: CheckoutParams): Promise<string> {
    try {
      // Get or create Stripe customer (provider-scoped to avoid picking up a Creem record)
      let customer = await this.billingRepo.findCustomerByUserIdAndProvider(params.userId, 'stripe');
      if (!customer) {
        const stripeCustomer = await this.client.createCustomer({
          email: params.email,
          name: params.metadata['displayName'] ?? params.email,
          metadata: { herobidsUserId: params.userId },
        });
        customer = await this.billingRepo.getOrCreateCustomer(params.userId, stripeCustomer.id, 'stripe');
      }

      // Resolve price ID from plan mapping, preferring the requested interval then first entry
      const priceId = params.priceId ?? this.resolvePriceId(params.planId, params.interval);
      if (!priceId) {
        throw new Error(`No Stripe price mapping for plan '${params.planId}'`);
      }

      const session = await this.client.createCheckoutSession({
        customerId: customer.externalCustomerId,
        priceId,
        successUrl: params.successUrl,
        cancelUrl: params.cancelUrl,
        metadata: {
          ...params.metadata,
          herobidsUserId: params.userId,
          herobidsPlanId: params.planId,
        },
      });

      return session.url;
    } catch (err) {
      if (err instanceof StripeNetworkError) {
        throw new ProviderUnavailableError('stripe', err.message, err);
      }
      throw err;
    }
  }

  async createPortalUrl(params: PortalParams): Promise<string> {
    try {
      const session = await this.client.createPortalSession({
        customerId: params.customerId,
        returnUrl: params.returnUrl,
        configurationId: this.stripeConfig.customerPortalConfigurationId || undefined,
      });
      return session.url;
    } catch (err) {
      if (err instanceof StripeNetworkError) {
        throw new ProviderUnavailableError('stripe', err.message, err);
      }
      throw err;
    }
  }

  async cancelSubscription(externalSubscriptionId: string, atPeriodEnd = true): Promise<void> {
    try {
      await this.client.cancelSubscription(externalSubscriptionId, atPeriodEnd);
    } catch (err) {
      if (err instanceof StripeNetworkError) {
        throw new ProviderUnavailableError('stripe', err.message, err);
      }
      throw err;
    }
  }

  async upgradeSubscription(externalSubscriptionId: string, newPriceId: string, prorate: boolean): Promise<void> {
    try {
      await this.client.updateSubscriptionPrice(externalSubscriptionId, newPriceId, prorate);
    } catch (err) {
      if (err instanceof StripeNetworkError) {
        throw new ProviderUnavailableError('stripe', err.message, err);
      }
      throw err;
    }
  }

  verifyWebhook(payload: string, headers: Record<string, string>): NormalizedWebhookEvent {
    const sigHeader = headers['stripe-signature'] ?? '';
    const event = this.client.verifyWebhookSignature(payload, sigHeader);
    return this.normalizeEvent(event);
  }

  // --- Private helpers ---

  private resolvePriceId(planId: string, interval?: 'month' | 'year'): string | null {
    const prices = this.stripeConfig.planPrices[planId];
    if (!prices || prices.length === 0) return null;
    if (interval) {
      const match = prices.find((p) => p.interval === interval);
      if (match) return match.stripePriceId;
    }
    return prices[0]!.stripePriceId;
  }

  private normalizeEvent(event: StripeEvent): NormalizedWebhookEvent {
    // invoice.payment_failed carries an invoice object, not a subscription
    if (event.type === 'invoice.payment_failed') {
      return this.normalizeInvoiceEvent(event);
    }

    const sub = event.data.object as unknown as StripeSubscription;
    const stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : '';

    return {
      id: event.id,
      type: mapStripeEventType(event.type),
      provider: 'stripe',
      subscriptionId: sub.id ?? '',
      customerId: stripeCustomerId,
      productOrPriceId: sub.items?.data?.[0]?.price?.id ?? '',
      status: sub.status ?? '',
      currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      metadata: sub.metadata ?? {},
      createdAt: new Date(event.created * 1000),
    };
  }

  private normalizeInvoiceEvent(event: StripeEvent): NormalizedWebhookEvent {
    const inv = event.data.object as unknown as StripeInvoice;
    return {
      id: event.id,
      type: 'payment.failed',
      provider: 'stripe',
      subscriptionId: typeof inv.subscription === 'string' ? inv.subscription : '',
      customerId: typeof inv.customer === 'string' ? inv.customer : '',
      productOrPriceId: inv.lines?.data?.[0]?.price?.id ?? '',
      status: 'past_due',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: inv.metadata ?? {},
      createdAt: new Date(event.created * 1000),
    };
  }
}

interface StripeInvoice {
  subscription: string | null;
  customer: string;
  lines?: { data: Array<{ price?: { id: string } }> };
  metadata?: Record<string, string>;
}

function mapStripeEventType(eventType: string): NormalizedWebhookEvent['type'] {
  switch (eventType) {
    case 'customer.subscription.created':
      return 'subscription.created';
    case 'customer.subscription.updated':
      return 'subscription.updated';
    case 'customer.subscription.deleted':
      return 'subscription.canceled';
    case 'invoice.payment_failed':
      return 'payment.failed';
    default:
      throw new UnknownWebhookEventTypeError(eventType);
  }
}
