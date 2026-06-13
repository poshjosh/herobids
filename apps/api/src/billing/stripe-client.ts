import crypto from 'node:crypto';
import type { StripeConfig } from '@herobids/domain';

/**
 * Minimal Stripe API client — wraps fetch calls to Stripe's REST API.
 * Avoids pulling in the full `stripe` SDK as a dependency. If usage grows,
 * swap for the official SDK.
 */
export class StripeClient {
  private readonly baseUrl = 'https://api.stripe.com/v1';
  private readonly headers: Record<string, string>;

  constructor(private readonly config: StripeConfig) {
    this.headers = {
      'Authorization': `Bearer ${config.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  // --- Customers ---

  async createCustomer(params: { email: string; name: string; metadata?: Record<string, string> }): Promise<StripeCustomer> {
    const body = new URLSearchParams();
    body.set('email', params.email);
    body.set('name', params.name);
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post<StripeCustomer>('/customers', body);
  }

  // --- Checkout Sessions ---

  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    mode?: 'subscription' | 'payment';
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<StripeCheckoutSession> {
    const body = new URLSearchParams();
    body.set('customer', params.customerId);
    body.set('mode', params.mode ?? 'subscription');
    body.set('line_items[0][price]', params.priceId);
    body.set('line_items[0][quantity]', '1');
    body.set('success_url', params.successUrl);
    body.set('cancel_url', params.cancelUrl);
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        body.set(`metadata[${k}]`, v);
      }
    }
    return this.post<StripeCheckoutSession>('/checkout/sessions', body);
  }

  // --- Customer Portal ---

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
    configurationId?: string;
  }): Promise<StripePortalSession> {
    const body = new URLSearchParams();
    body.set('customer', params.customerId);
    body.set('return_url', params.returnUrl);
    if (params.configurationId) {
      body.set('configuration', params.configurationId);
    }
    return this.post<StripePortalSession>('/billing_portal/sessions', body);
  }

  // --- Webhook Signature Verification ---

  /**
   * Verify a Stripe webhook signature. Returns the parsed event or throws on
   * invalid signature.
   */
  verifyWebhookSignature(payload: string | Buffer, sigHeader: string): StripeEvent {
    const secret = this.config.webhookSecret;
    const parts = sigHeader.split(',');
    let timestamp = '';
    const signatures: string[] = [];

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') timestamp = value!;
      if (key === 'v1') signatures.push(value!);
    }

    if (!timestamp || signatures.length === 0) {
      throw new StripeSignatureError('Invalid Stripe signature header format');
    }

    // Check timestamp tolerance (5 minutes)
    const eventTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - eventTime) > 300) {
      throw new StripeSignatureError('Stripe webhook timestamp outside tolerance window');
    }

    const signedPayload = `${timestamp}.${typeof payload === 'string' ? payload : payload.toString('utf8')}`;
    const expectedSig = computeHmacSha256(secret, signedPayload);

    const valid = signatures.some((sig) => timingSafeEqual(sig, expectedSig));
    if (!valid) {
      throw new StripeSignatureError('Stripe webhook signature verification failed');
    }

    return JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8')) as StripeEvent;
  }

  // --- Internal HTTP helpers ---

  private async post<T>(path: string, body: URLSearchParams): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: body.toString(),
      });
    } catch (err) {
      throw new StripeNetworkError('Network error contacting Stripe', err);
    }

    if (res.status >= 500) {
      throw new StripeNetworkError(`Stripe server error ${res.status}`);
    }

    const json = await res.json() as T & { error?: { message: string; type: string } };
    if (!res.ok) {
      const errMsg = (json as { error?: { message: string } }).error?.message ?? `Stripe API error ${res.status}`;
      throw new StripeApiError(res.status, errMsg);
    }
    return json;
  }

  private async delete<T>(path: string, body?: URLSearchParams): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: this.headers,
        body: body?.toString(),
      });
    } catch (err) {
      throw new StripeNetworkError('Network error contacting Stripe', err);
    }

    if (res.status >= 500) {
      throw new StripeNetworkError(`Stripe server error ${res.status}`);
    }

    const json = await res.json() as T & { error?: { message: string; type: string } };
    if (!res.ok) {
      const errMsg = (json as { error?: { message: string } }).error?.message ?? `Stripe API error ${res.status}`;
      throw new StripeApiError(res.status, errMsg);
    }
    return json;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.headers,
      });
    } catch (err) {
      throw new StripeNetworkError('Network error contacting Stripe', err);
    }

    if (res.status >= 500) {
      throw new StripeNetworkError(`Stripe server error ${res.status}`);
    }

    const json = await res.json() as T & { error?: { message: string; type: string } };
    if (!res.ok) {
      const errMsg = (json as { error?: { message: string } }).error?.message ?? `Stripe API error ${res.status}`;
      throw new StripeApiError(res.status, errMsg);
    }
    return json;
  }

  // --- Subscription management ---

  async getSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return this.get<StripeSubscription>(`/subscriptions/${subscriptionId}`);
  }

  async cancelSubscription(subscriptionId: string, atPeriodEnd = true): Promise<StripeSubscription> {
    if (atPeriodEnd) {
      const body = new URLSearchParams();
      body.set('cancel_at_period_end', 'true');
      return this.post<StripeSubscription>(`/subscriptions/${subscriptionId}`, body);
    }
    return this.delete<StripeSubscription>(`/subscriptions/${subscriptionId}`);
  }

  async updateSubscriptionPrice(subscriptionId: string, newPriceId: string, prorate: boolean): Promise<StripeSubscription> {
    // Fetch subscription to get the existing item ID — required by Stripe to replace
    // rather than add a new line item, which would cause double-billing.
    const subscription = await this.getSubscription(subscriptionId);
    const itemId = subscription.items?.data?.[0]?.id;

    const body = new URLSearchParams();
    if (itemId) {
      body.set('items[0][id]', itemId);
    }
    body.set('items[0][price]', newPriceId);
    body.set('proration_behavior', prorate ? 'create_prorations' : 'none');
    return this.post<StripeSubscription>(`/subscriptions/${subscriptionId}`, body);
  }
}

// --- Crypto helpers (Node.js native) ---

function computeHmacSha256(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Error types ---

export class StripeApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'StripeApiError';
  }
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

export class StripeNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StripeNetworkError';
  }
}

// --- Stripe response types (minimal subset) ---

export interface StripeCustomer {
  id: string;
  email: string;
  name: string;
  metadata: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
  customer: string;
  subscription: string | null;
  metadata: Record<string, string>;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  items: { data: Array<{ id: string; price: { id: string } }> };
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  trial_end: number | null;
  metadata: Record<string, string>;
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
}
