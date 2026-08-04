import crypto from 'node:crypto';
import type { CreemConfig } from '@herobids/domain';
import type {
  PaymentProvider,
  CheckoutParams,
  PortalParams,
  NormalizedWebhookEvent,
} from './provider-port.js';
import { ProviderUnavailableError, UnknownWebhookEventTypeError } from './provider-port.js';

/**
 * Creem payment provider adapter.
 *
 * Creem REST API: https://api.creem.io/v1 (test: https://test-api.creem.io/v1)
 * Auth: x-api-key header
 * Webhook: HMAC-SHA256 of raw body in creem-signature header
 */
export class CreemProvider implements PaymentProvider {
  readonly name = 'creem' as const;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: CreemConfig) {
    // Auto-switch to test URL if key is a test key
    this.baseUrl = config.apiKey.startsWith('creem_test_')
      ? 'https://test-api.creem.io/v1'
      : config.apiBaseUrl;

    this.headers = {
      'x-api-key': config.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async createCheckoutUrl(params: CheckoutParams): Promise<string> {
    // Use the explicitly selected price/product ID when provided; otherwise resolve by interval then first entry.
    const productEntry = params.priceId ?? this.resolveProductId(params.planId, params.interval);
    if (!productEntry) {
      throw new Error(`No Creem product mapping for plan '${params.planId}'`);
    }

    const body = {
      product_id: productEntry,
      success_url: params.successUrl,
      metadata: {
        ...params.metadata,
        referenceId: params.userId,
        planType: params.planId,
      },
      customer: { email: params.email },
    };

    const response = await this.post<{ checkout_url: string }>('/checkouts', body);
    return response.checkout_url;
  }

  async createPortalUrl(params: PortalParams): Promise<string> {
    const response = await this.post<{ portal_url: string }>('/customers/portal', {
      customer_id: params.customerId,
      return_url: params.returnUrl,
    });
    return response.portal_url;
  }

  async cancelSubscription(externalSubscriptionId: string, atPeriodEnd = true): Promise<void> {
    await this.post(`/subscriptions/${externalSubscriptionId}/cancel`, {
      at_period_end: atPeriodEnd,
    });
  }

  async upgradeSubscription(externalSubscriptionId: string, newProductId: string, prorate: boolean): Promise<void> {
    await this.post(`/subscriptions/${externalSubscriptionId}/upgrade`, {
      product_id: newProductId,
      update_behavior: prorate ? 'proration-charge-immediately' : 'proration-none',
    });
  }

  verifyWebhook(payload: string, headers: Record<string, string>): NormalizedWebhookEvent {
    const signature = headers['creem-signature'] ?? headers['Creem-Signature'] ?? '';
    if (!signature) {
      throw new CreemSignatureError('Missing creem-signature header');
    }

    const computed = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');

    if (!timingSafeEqual(computed, signature)) {
      throw new CreemSignatureError('Creem webhook signature verification failed');
    }

    const raw = JSON.parse(payload);
    // Creem sends "eventType" (camelCase) in production; older docs referenced
    // "event_type" (snake_case). Accept either so the provider works regardless.
    const event: CreemWebhookPayload = {
      ...raw,
      event_type: raw.event_type ?? raw.eventType ?? '',
    };
    return this.normalizeEvent(event);
  }

  // --- Private helpers ---

  private resolveProductId(planId: string, interval?: 'month' | 'year'): string | null {
    const products = this.config.planProducts[planId];
    if (!products || products.length === 0) return null;
    if (interval) {
      const match = products.find((p) => p.interval === interval);
      if (match) return match.creemProductId;
    }
    return products[0]!.creemProductId;
  }

  private normalizeEvent(event: CreemWebhookPayload): NormalizedWebhookEvent {
    const sub = event.object ?? {};
    if (event.event_type === 'checkout.completed' && sub.metadata?.['checkoutKind'] === 'top_up') {
      return {
        id: event.id ?? crypto.randomUUID(),
        type: 'top_up.completed',
        provider: 'creem',
        subscriptionId: '',
        customerId: sub.customer_id ?? sub.customer?.id ?? '',
        productOrPriceId: sub.product_id ?? sub.product?.id ?? '',
        status: 'paid',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        trialEnd: null,
        metadata: sub.metadata ?? {},
        createdAt: event.created_at ? new Date(event.created_at) : new Date(),
      };
    }
    // event.event_type is always a string at runtime (normalized at L96 with ?? ''),
    // but the TS interface types it as optional. Assert non-null.
    const type = mapCreemEventType(event.event_type!);

    return {
      id: event.id ?? crypto.randomUUID(),
      type,
      provider: 'creem',
      subscriptionId: sub.id ?? '',
      customerId: sub.customer_id ?? sub.customer?.id ?? '',
      productOrPriceId: sub.product_id ?? sub.product?.id ?? '',
      status: sub.status ?? event.event_type!,
      currentPeriodStart: sub.current_period_start_date ? new Date(sub.current_period_start_date) : null,
      currentPeriodEnd: sub.current_period_end_date ? new Date(sub.current_period_end_date) : null,
      cancelAtPeriodEnd: sub.status === 'scheduled_cancel',
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at) : null,
      trialEnd: sub.trial_end ? new Date(sub.trial_end) : null,
      metadata: sub.metadata ?? {},
      createdAt: event.created_at ? new Date(event.created_at) : new Date(),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderUnavailableError('creem', 'Network error', err);
    }

    if (res.status >= 500) {
      throw new ProviderUnavailableError('creem', `Server error ${res.status}`);
    }

    const json = await res.json() as T & { message?: string };
    if (!res.ok) {
      throw new CreemApiError(res.status, json.message ?? `Creem API error ${res.status}`);
    }
    return json;
  }
}

// --- Event type mapping ---

function mapCreemEventType(eventType: string): NormalizedWebhookEvent['type'] {
  switch (eventType) {
    case 'subscription.active':
      return 'subscription.created';
    case 'subscription.paid':
    case 'subscription.update':
    case 'subscription.trialing':
    case 'subscription.paused':
    case 'subscription.scheduled_cancel':
      return 'subscription.updated';
    case 'subscription.canceled':
    case 'subscription.expired':
      return 'subscription.canceled';
    case 'subscription.past_due':
      return 'payment.failed';
    default:
      throw new UnknownWebhookEventTypeError(eventType);
  }
}

// --- Crypto helper ---

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Error types ---

export class CreemApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'CreemApiError';
  }
}

export class CreemSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreemSignatureError';
  }
}

// --- Creem webhook payload types ---

interface CreemSubscriptionObject {
  id?: string;
  customer_id?: string;
  customer?: { id?: string; email?: string; name?: string; metadata?: Record<string, string> };
  product_id?: string;
  product?: { id?: string; name?: string };
  status?: string;
  current_period_start_date?: string;
  current_period_end_date?: string;
  canceled_at?: string;
  trial_end?: string;
  metadata?: Record<string, string>;
}

interface CreemWebhookPayload {
  id?: string;
  event_type?: string;
  eventType?: string;   // Creem sends camelCase in production webhooks
  object?: CreemSubscriptionObject;
  created_at?: string;
}
