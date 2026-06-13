import { describe, expect, it } from 'vitest';
import type { BillingProvider } from '@herobids/domain';
import type { PaymentProvider, CheckoutParams, PortalParams, NormalizedWebhookEvent } from './provider-port.js';
import { PaymentProviderManager } from './provider-manager.js';

function stubProvider(name: BillingProvider): PaymentProvider {
  return {
    name,
    createCheckoutUrl: async (params: CheckoutParams) => `checkout:${name}:${params.planId}`,
    createPortalUrl: async (params: PortalParams) => `portal:${name}:${params.customerId}`,
    cancelSubscription: async () => undefined,
    upgradeSubscription: async () => undefined,
    verifyWebhook: (_payload: string, _headers: Record<string, string>): NormalizedWebhookEvent => ({
      id: `evt_${name}`,
      type: 'subscription.created',
      provider: name,
      subscriptionId: `sub_${name}`,
      customerId: `cus_${name}`,
      productOrPriceId: `price_${name}`,
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date('2026-06-13T00:00:00.000Z'),
    }),
  };
}

describe('PaymentProviderManager', () => {
  it('routes checkout through any configured provider', async () => {
    const primary = stubProvider('mock');
    const fallback = stubProvider('stripe');
    const extra = stubProvider('creem');
    const manager = new PaymentProviderManager(primary, fallback, new Map([
      ['mock', primary],
      ['stripe', fallback],
      ['creem', extra],
    ]));

    const result = await manager.createCheckoutUrlViaProvider({
      userId: 'user-1',
      email: 'user@example.com',
      planId: 'top_up_starter_500',
      priceId: 'creem_pack_starter_500',
      successUrl: 'https://success.example',
      cancelUrl: 'https://cancel.example',
      metadata: {},
    }, 'creem');

    expect(result).toEqual({ url: 'checkout:creem:top_up_starter_500', provider: 'creem' });
  });
});import { describe, it, expect, vi } from 'vitest';
import { PaymentProviderManager } from './provider-manager.js';
import { ProviderUnavailableError } from './provider-port.js';
import type { PaymentProvider, NormalizedWebhookEvent } from './provider-port.js';

function makeMockProvider(name: 'creem' | 'stripe' | 'mock', overrides?: Partial<PaymentProvider>): PaymentProvider {
  return {
    name,
    createCheckoutUrl: vi.fn().mockResolvedValue('https://checkout.example.com'),
    createPortalUrl: vi.fn().mockResolvedValue('https://portal.example.com'),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    upgradeSubscription: vi.fn().mockResolvedValue(undefined),
    verifyWebhook: vi.fn().mockReturnValue({
      id: 'evt_1',
      type: 'subscription.created',
      provider: name,
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      productOrPriceId: 'prod_1',
      status: 'active',
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      metadata: {},
      createdAt: new Date(),
    } satisfies NormalizedWebhookEvent),
    ...overrides,
  };
}

describe('PaymentProviderManager', () => {
  describe('createCheckoutUrl', () => {
    it('uses primary provider on success', async () => {
      const primary = makeMockProvider('creem');
      const fallback = makeMockProvider('stripe');
      const manager = new PaymentProviderManager(primary, fallback);

      const result = await manager.createCheckoutUrl({
        userId: 'user_1',
        email: 'test@example.com',
        planId: 'pro',
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });

      expect(result.url).toBe('https://checkout.example.com');
      expect(result.provider).toBe('creem');
      expect(fallback.createCheckoutUrl).not.toHaveBeenCalled();
    });

    it('falls back when primary throws ProviderUnavailableError', async () => {
      const primary = makeMockProvider('creem', {
        createCheckoutUrl: vi.fn().mockRejectedValue(new ProviderUnavailableError('creem', 'Network error')),
      });
      const fallback = makeMockProvider('stripe');
      const manager = new PaymentProviderManager(primary, fallback);

      const result = await manager.createCheckoutUrl({
        userId: 'user_1',
        email: 'test@example.com',
        planId: 'pro',
        successUrl: 'https://app.test/success',
        cancelUrl: 'https://app.test/cancel',
      });

      expect(result.url).toBe('https://checkout.example.com');
      expect(result.provider).toBe('stripe');
    });

    it('throws when primary fails and no fallback configured', async () => {
      const primary = makeMockProvider('creem', {
        createCheckoutUrl: vi.fn().mockRejectedValue(new ProviderUnavailableError('creem', 'Down')),
      });
      const manager = new PaymentProviderManager(primary, null);

      await expect(
        manager.createCheckoutUrl({
          userId: 'user_1',
          email: 'test@example.com',
          planId: 'pro',
          successUrl: 'https://app.test/success',
          cancelUrl: 'https://app.test/cancel',
        }),
      ).rejects.toThrow(ProviderUnavailableError);
    });

    it('propagates non-ProviderUnavailableError without fallback attempt', async () => {
      const primary = makeMockProvider('creem', {
        createCheckoutUrl: vi.fn().mockRejectedValue(new Error('Validation error')),
      });
      const fallback = makeMockProvider('stripe');
      const manager = new PaymentProviderManager(primary, fallback);

      await expect(
        manager.createCheckoutUrl({
          userId: 'user_1',
          email: 'test@example.com',
          planId: 'pro',
          successUrl: 'https://app.test/success',
          cancelUrl: 'https://app.test/cancel',
        }),
      ).rejects.toThrow('Validation error');
      expect(fallback.createCheckoutUrl).not.toHaveBeenCalled();
    });
  });

  describe('cancelSubscription', () => {
    it('routes to owning provider', async () => {
      const primary = makeMockProvider('creem');
      const fallback = makeMockProvider('stripe');
      const manager = new PaymentProviderManager(primary, fallback);

      await manager.cancelSubscription('sub_1', 'stripe', true);

      expect(fallback.cancelSubscription).toHaveBeenCalledWith('sub_1', true);
      expect(primary.cancelSubscription).not.toHaveBeenCalled();
    });

    it('throws if owning provider not registered', async () => {
      const primary = makeMockProvider('creem');
      const manager = new PaymentProviderManager(primary, null);

      await expect(
        manager.cancelSubscription('sub_1', 'stripe', true),
      ).rejects.toThrow("No provider registered for 'stripe'");
    });
  });

  describe('getProvider', () => {
    it('returns registered provider by name', () => {
      const primary = makeMockProvider('creem');
      const fallback = makeMockProvider('stripe');
      const manager = new PaymentProviderManager(primary, fallback);

      expect(manager.getProvider('creem')).toBe(primary);
      expect(manager.getProvider('stripe')).toBe(fallback);
    });

    it('returns undefined for unregistered provider', () => {
      const primary = makeMockProvider('creem');
      const manager = new PaymentProviderManager(primary, null);

      expect(manager.getProvider('stripe')).toBeUndefined();
    });
  });
});
