import type { BillingConfig, BillingProvider } from '@herobids/domain';
import type { BillingRepository } from '@herobids/db';
import type { PaymentProvider, CheckoutParams, PortalParams } from './provider-port.js';
import { ProviderUnavailableError } from './provider-port.js';
import { CreemProvider } from './creem-provider.js';
import { StripeProvider } from './stripe-provider.js';
import { MockProvider } from './mock-provider.js';

/**
 * Orchestrates primary + fallback payment provider failover.
 *
 * Failover semantics:
 * - Outbound calls (checkout, portal): try primary, on ProviderUnavailableError try fallback.
 * - Subscription-bound calls (cancel, upgrade): routed to the owning provider, no fallback.
 */
export class PaymentProviderManager {
  private readonly primary: PaymentProvider;
  private readonly fallback: PaymentProvider | null;
  private readonly providers: Map<BillingProvider, PaymentProvider>;

  constructor(
    primary: PaymentProvider,
    fallback: PaymentProvider | null,
    providers?: Map<BillingProvider, PaymentProvider>,
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.providers = providers ? new Map(providers) : new Map();
    this.providers.set(primary.name, primary);
    if (fallback) {
      this.providers.set(fallback.name, fallback);
    }
  }

  get primaryProvider(): PaymentProvider {
    return this.primary;
  }

  get fallbackProvider(): PaymentProvider | null {
    return this.fallback;
  }

  getProvider(name: BillingProvider): PaymentProvider | undefined {
    return this.providers.get(name);
  }

  async createCheckoutUrl(params: CheckoutParams): Promise<{ url: string; provider: BillingProvider }> {
    try {
      const url = await this.primary.createCheckoutUrl(params);
      return { url, provider: this.primary.name };
    } catch (err) {
      if (err instanceof ProviderUnavailableError && this.fallback) {
        // priceId is primary-provider-specific; strip it so the fallback resolves its own mapping.
        const url = await this.fallback.createCheckoutUrl({ ...params, priceId: undefined });
        return { url, provider: this.fallback.name };
      }
      throw err;
    }
  }

  /**
   * Create a checkout URL via a specific provider (e.g. for top-up packs defined per-provider).
   * If the target provider is unavailable, does NOT fall back — the priceId is provider-specific.
   */
  async createCheckoutUrlViaProvider(params: CheckoutParams, targetProvider: BillingProvider): Promise<{ url: string; provider: BillingProvider }> {
    const provider = this.providers.get(targetProvider);
    if (!provider) {
      throw new Error(`No provider registered for '${targetProvider}'`);
    }
    const url = await provider.createCheckoutUrl(params);
    return { url, provider: targetProvider };
  }

  async createPortalUrl(params: PortalParams, owningProvider: BillingProvider): Promise<string> {
    const provider = this.providers.get(owningProvider);
    if (!provider) {
      throw new Error(`No provider registered for '${owningProvider}'`);
    }
    // No failover: portal customer IDs are provider-specific and cannot be reused
    // by a different provider. If the owning provider is unavailable, let the caller
    // surface a "try again later" error rather than sending a foreign customer ID.
    return await provider.createPortalUrl(params);
  }

  async cancelSubscription(externalSubscriptionId: string, owningProvider: BillingProvider, atPeriodEnd?: boolean): Promise<void> {
    const provider = this.providers.get(owningProvider);
    if (!provider) {
      throw new Error(`No provider registered for '${owningProvider}'`);
    }
    await provider.cancelSubscription(externalSubscriptionId, atPeriodEnd);
  }

  async upgradeSubscription(
    externalSubscriptionId: string,
    owningProvider: BillingProvider,
    currentProductOrPriceId: string,
    newProductOrPriceId: string,
    prorate: boolean,
  ): Promise<void> {
    const provider = this.providers.get(owningProvider);
    if (!provider) {
      throw new Error(`No provider registered for '${owningProvider}'`);
    }
    await provider.upgradeSubscription(externalSubscriptionId, currentProductOrPriceId, newProductOrPriceId, prorate);
  }
}

/**
 * Factory — resolves config into a fully wired PaymentProviderManager.
 */
export function createProviderManager(
  billingConfig: BillingConfig,
  billingRepo: BillingRepository,
): PaymentProviderManager {
  const providers = new Map<BillingProvider, PaymentProvider>();

  if (billingConfig.primaryProvider === 'mock' || billingConfig.fallbackProvider === 'mock') {
    providers.set('mock', new MockProvider());
  }
  if (billingConfig.stripe.secretKey) {
    providers.set('stripe', new StripeProvider(billingConfig.stripe, billingRepo));
  }
  if (billingConfig.creem.apiKey) {
    providers.set('creem', new CreemProvider(billingConfig.creem));
  }

  const primary = providers.get(billingConfig.primaryProvider);
  if (!primary) {
    throw new Error(`Primary billing provider '${billingConfig.primaryProvider}' is not configured`);
  }

  const fallback = billingConfig.fallbackProvider
    ? providers.get(billingConfig.fallbackProvider) ?? null
    : null;

  return new PaymentProviderManager(primary, fallback, providers);
}
