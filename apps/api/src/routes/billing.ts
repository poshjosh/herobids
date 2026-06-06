import type { FastifyInstance } from 'fastify';
import type { BillingConfig, BillingProvider, PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { BillingRepository, users, fills, bots, agents } from '@herobids/db';
import { eq, and, desc, gte, lte, inArray, or, type SQL } from 'drizzle-orm';
import { createProviderManager } from '../billing/provider-manager.js';
import { EntitlementSync } from '../billing/entitlement-sync.js';
import { CreemSignatureError } from '../billing/creem-provider.js';
import { StripeSignatureError } from '../billing/stripe-client.js';
import { UnknownWebhookEventTypeError } from '../billing/provider-port.js';
import { MockProvider } from '../billing/mock-provider.js';

/**
 * Billing routes — multi-provider checkout, portal, cancel, upgrade, webhooks, and summary.
 *
 * Route visibility:
 * - POST /billing/webhook — public (alias for primary provider webhook)
 * - POST /billing/webhook/stripe — public (Stripe signature-verified)
 * - POST /billing/webhook/creem — public (Creem signature-verified)
 * - GET /billing/summary — authenticated
 * - POST /billing/checkout-session — authenticated
 * - POST /billing/customer-portal — authenticated
 * - POST /billing/cancel-subscription — authenticated
 * - POST /billing/upgrade-subscription — authenticated
 */
export async function billingRoutes(
  app: FastifyInstance,
  billingConfig: BillingConfig,
  plansConfig: PlansConfig,
  db: Database,
) {
  const billingRepo = new BillingRepository(db);
  const providerManager = createProviderManager(billingConfig, billingRepo);
  const entitlementSync = new EntitlementSync(billingRepo, billingConfig, plansConfig.defaultPlanId);

  // -------------------------------------------------------------------------
  // GET /billing/summary — current user's billing state
  // -------------------------------------------------------------------------
  app.get('/billing/summary', async (request, reply) => {
    const userId = request.userId;

    const subscription = await billingRepo.findSubscriptionByUserId(userId);
    // Use the subscription's provider to find the right customer record.
    const customer = subscription?.provider
      ? await billingRepo.findCustomerByUserIdAndProvider(userId, subscription.provider)
      : await billingRepo.findCustomerByUserId(userId);

    // Look up current plan info
    const [user] = await db.select({ planId: users.planId }).from(users).where(eq(users.id, userId)).limit(1);
    const planId = user?.planId ?? plansConfig.defaultPlanId;
    const planLimits = plansConfig.plans[planId] ?? plansConfig.plans[plansConfig.defaultPlanId];

    // Resolve display label from billing config
    let planLabel = planId;
    let billingInterval: string | null = null;
    if (subscription) {
      const entry = resolveDisplayInfo(billingConfig, subscription.provider, subscription.externalPriceOrProductId);
      if (entry) {
        planLabel = entry.displayLabel;
        billingInterval = entry.interval;
      }
    }

    // Build available plans from the subscription's owning provider so upgrade uses the same provider.
    // If no subscription exists yet, use the primary provider for the initial checkout flow.
    const availablePlansProvider = subscription?.provider ?? billingConfig.primaryProvider;
    const availablePlans = availablePlansProvider === 'stripe'
      ? Object.entries(billingConfig.stripe.planPrices)
          .filter(([id]) => id !== planId)
          .map(([id, prices]) => ({
            planId: id,
            prices: prices.map((p) => ({
              id: p.stripePriceId,
              interval: p.interval,
              displayLabel: p.displayLabel,
              amountCents: p.amountCents ?? null,
            })),
          }))
      : availablePlansProvider === 'creem'
      ? Object.entries(billingConfig.creem.planProducts)
          .filter(([id]) => id !== planId)
          .map(([id, products]) => ({
            planId: id,
            prices: products.map((p) => ({
              id: p.creemProductId,
              interval: p.interval,
              displayLabel: p.displayLabel,
              amountCents: p.amountCents ?? null,
            })),
          }))
      : /* mock — all configured plans are selectable in dev */ Object.keys(plansConfig.plans)
          .filter((id) => id !== planId)
          .map((id) => ({
            planId: id,
            prices: [{ id: `mock_product_${id}`, interval: 'month' as const, displayLabel: id, amountCents: null }],
          }));

    return reply.send({
      planId,
      planLabel,
      billingInterval,
      planLimits: planLimits ?? null,
      hasPaymentCustomer: !!customer,
      provider: subscription?.provider ?? billingConfig.primaryProvider,
      subscription: subscription
        ? {
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            canceledAt: subscription.canceledAt?.toISOString() ?? null,
            trialEnd: subscription.trialEnd?.toISOString() ?? null,
          }
        : null,
      availablePlans,
    });
  });

  // -------------------------------------------------------------------------
  // POST /billing/checkout-session — create a checkout session via provider manager
  // -------------------------------------------------------------------------
  app.post<{ Body: { planId: string; priceId?: string } }>('/billing/checkout-session', async (request, reply) => {
    const userId = request.userId;
    const { planId: targetPlanId, priceId: targetPriceId } = request.body as { planId?: string; priceId?: string };

    if (!targetPlanId || typeof targetPlanId !== 'string') {
      return reply.status(400).send({ error: 'planId is required' });
    }

    // Validate plan exists in plans config
    if (!(targetPlanId in plansConfig.plans)) {
      return reply.status(400).send({ error: 'Invalid planId — not found in plans configuration' });
    }

    // Validate priceId belongs to the requested plan, scoped to the primary provider
    // (prevents cross-provider IDs reaching an adapter that cannot resolve them).
    if (targetPriceId !== undefined && !isPriceIdValidForPlan(billingConfig, targetPlanId, targetPriceId, billingConfig.primaryProvider)) {
      return reply.status(400).send({ error: `priceId is not valid for plan '${targetPlanId}'` });
    }

    // Fetch user info
    const [user] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const { url, provider } = await providerManager.createCheckoutUrl({
      userId,
      email: user.email,
      planId: targetPlanId,
      priceId: targetPriceId,
      interval: targetPriceId ? resolveIntervalFromPriceId(billingConfig, targetPlanId, targetPriceId) : undefined,
      successUrl: billingConfig.checkoutSuccessUrl,
      cancelUrl: billingConfig.checkoutCancelUrl,
      metadata: { displayName: user.displayName },
    });

    // Dev auto-fulfill: when mock provider is active, immediately process
    // a synthetic subscription event so the plan activates without a real payment.
    if (provider === 'mock') {
      const mockProvider = providerManager.getProvider('mock') as MockProvider;
      const syntheticEvent = mockProvider.createSyntheticEvent({
        userId,
        planId: targetPlanId,
        productOrPriceId: `mock_product_${targetPlanId}`,
      });
      await entitlementSync.processEvent(syntheticEvent);
    }

    return reply.send({ url, provider });
  });

  // -------------------------------------------------------------------------
  // POST /billing/customer-portal — redirect to provider's customer portal
  // -------------------------------------------------------------------------
  app.post('/billing/customer-portal', async (request, reply) => {
    const userId = request.userId;

    // Use the subscription's provider to find the right customer record.
    const subscription = await billingRepo.findSubscriptionByUserId(userId);
    if (!subscription) {
      return reply.status(400).send({ error: 'No billing account found. Please start a subscription first.' });
    }
    const customer = await billingRepo.findCustomerByUserIdAndProvider(userId, subscription.provider);
    if (!customer) {
      return reply.status(400).send({ error: 'No billing account found. Please start a subscription first.' });
    }

    const url = await providerManager.createPortalUrl(
      {
        customerId: customer.externalCustomerId,
        returnUrl: billingConfig.checkoutSuccessUrl.replace(/\?.*$/, ''),
      },
      subscription.provider as 'creem' | 'stripe',
    );

    return reply.send({ url });
  });

  // -------------------------------------------------------------------------
  // POST /billing/cancel-subscription — cancel user's active subscription
  // -------------------------------------------------------------------------
  app.post('/billing/cancel-subscription', async (request, reply) => {
    const userId = request.userId;

    const subscription = await billingRepo.findSubscriptionByUserId(userId);
    if (!subscription) {
      return reply.status(400).send({ error: 'No active subscription found' });
    }

    if (subscription.status === 'canceled') {
      return reply.status(400).send({ error: 'Subscription is already canceled' });
    }

    await providerManager.cancelSubscription(
      subscription.externalSubscriptionId,
      subscription.provider as 'creem' | 'stripe',
      true, // cancel at period end
    );

    // Mock provider is stateless — synthesize a cancel event so the subscription
    // row reflects cancelAtPeriodEnd immediately without an external webhook.
    if (subscription.provider === 'mock') {
      const mockProvider = providerManager.getProvider('mock') as MockProvider;
      const syntheticEvent = mockProvider.createSyntheticCancelEvent({
        subscriptionId: subscription.externalSubscriptionId,
        customerId: subscription.externalCustomerId,
        productOrPriceId: subscription.externalPriceOrProductId,
        userId,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      });
      await entitlementSync.processEvent(syntheticEvent);
    }

    return reply.send({ success: true, cancelAtPeriodEnd: true });
  });

  // -------------------------------------------------------------------------
  // POST /billing/upgrade-subscription — upgrade/downgrade user's plan
  // -------------------------------------------------------------------------
  app.post<{ Body: { planId: string; priceId?: string } }>('/billing/upgrade-subscription', async (request, reply) => {
    const userId = request.userId;
    const { planId: newPlanId, priceId: newPriceId } = request.body as { planId?: string; priceId?: string };

    if (!newPlanId || typeof newPlanId !== 'string') {
      return reply.status(400).send({ error: 'planId is required' });
    }

    if (!(newPlanId in plansConfig.plans)) {
      return reply.status(400).send({ error: 'Invalid planId — not found in plans configuration' });
    }

    const subscription = await billingRepo.findSubscriptionByUserId(userId);
    if (!subscription) {
      return reply.status(400).send({ error: 'No active subscription found. Use checkout to subscribe.' });
    }

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return reply.status(400).send({ error: 'Subscription must be active or trialing to upgrade' });
    }

    // Resolve owning provider first so priceId validation is scoped to the correct provider.
    const provider = subscription.provider as BillingProvider;
    // Validate priceId against the owning provider only — prevents cross-provider ID injection.
    if (newPriceId !== undefined && !isPriceIdValidForPlan(billingConfig, newPlanId, newPriceId, provider)) {
      return reply.status(400).send({ error: `priceId is not valid for plan '${newPlanId}' with provider '${provider}'` });
    }

    const newProductOrPriceId = newPriceId ?? resolveTargetId(billingConfig, provider, newPlanId);
    if (!newProductOrPriceId) {
      return reply.status(400).send({ error: `No ${provider} mapping for plan '${newPlanId}'` });
    }

    await providerManager.upgradeSubscription(
      subscription.externalSubscriptionId,
      provider,
      newProductOrPriceId,
      true, // prorate
    );

    // Mock provider is stateless — synthesize an upgrade event so the plan
    // and subscription row reflect the new plan without an external webhook.
    if (subscription.provider === 'mock') {
      const mockProvider = providerManager.getProvider('mock') as MockProvider;
      const syntheticEvent = mockProvider.createSyntheticUpgradeEvent({
        subscriptionId: subscription.externalSubscriptionId,
        customerId: subscription.externalCustomerId,
        newPlanId,
        userId,
      });
      await entitlementSync.processEvent(syntheticEvent);
    }

    return reply.send({ success: true, newPlanId, provider });
  });

  // -------------------------------------------------------------------------
  // Webhooks — registered in encapsulated sub-plugins with raw body parsers
  // -------------------------------------------------------------------------
  app.register(async function webhookPlugin(sub) {
    sub.removeContentTypeParser('application/json');
    sub.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => { done(null, body); },
    );

    // POST /billing/webhook/stripe
    sub.post('/billing/webhook/stripe', async (request, reply) => {
      const stripeProvider = providerManager?.getProvider('stripe');
      if (!stripeProvider) {
        return reply.status(404).send({ error: 'Stripe provider not configured' });
      }

      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send({ error: 'Missing request body' });
      }

      let event;
      try {
        event = stripeProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof StripeSignatureError) {
          app.log.warn({ err: err.message }, 'Stripe webhook signature verification failed');
          return reply.status(400).send({ error: 'Invalid signature' });
        }
        if (err instanceof UnknownWebhookEventTypeError) {
          app.log.debug({ eventType: err.eventType }, 'Ignoring unsupported Stripe event type');
          return reply.status(200).send({ received: true });
        }
        throw err;
      }

      const result = await entitlementSync.processEvent(event);
      if (result.error) {
        app.log.error({ eventId: event.id, eventType: event.type, error: result.error }, 'Stripe webhook processing failed');
        return reply.status(500).send({ error: 'Webhook processing failed' });
      }
      return reply.status(200).send({ received: true });
    });

    // POST /billing/webhook/creem
    sub.post('/billing/webhook/creem', async (request, reply) => {
      const creemProvider = providerManager?.getProvider('creem');
      if (!creemProvider) {
        return reply.status(404).send({ error: 'Creem provider not configured' });
      }

      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send({ error: 'Missing request body' });
      }

      let event;
      try {
        event = creemProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof CreemSignatureError) {
          app.log.warn({ err: err.message }, 'Creem webhook signature verification failed');
          return reply.status(400).send({ error: 'Invalid signature' });
        }
        if (err instanceof UnknownWebhookEventTypeError) {
          app.log.debug({ eventType: err.eventType }, 'Ignoring unsupported Creem event type');
          return reply.status(200).send({ received: true });
        }
        throw err;
      }

      const result = await entitlementSync.processEvent(event);
      if (result.error) {
        app.log.error({ eventId: event.id, eventType: event.type, error: result.error }, 'Creem webhook processing failed');
        return reply.status(500).send({ error: 'Webhook processing failed' });
      }
      return reply.status(200).send({ received: true });
    });

    // POST /billing/webhook — alias for primary provider
    sub.post('/billing/webhook', async (request, reply) => {
      if (providerManager.primaryProvider.name === 'mock') {
        return reply.status(404).send({ error: 'No external webhook endpoint when using mock provider' });
      }
      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send({ error: 'Missing request body' });
      }

      let event;
      try {
        event = providerManager.primaryProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof StripeSignatureError || err instanceof CreemSignatureError) {
          app.log.warn({ err: (err as Error).message }, 'Webhook signature verification failed');
          return reply.status(400).send({ error: 'Invalid signature' });
        }
        if (err instanceof UnknownWebhookEventTypeError) {
          app.log.debug({ eventType: err.eventType }, 'Ignoring unsupported webhook event type');
          return reply.status(200).send({ received: true });
        }
        throw err;
      }

      const result = await entitlementSync.processEvent(event);
      if (result.error) {
        app.log.error({ eventId: event.id, eventType: event.type, error: result.error }, 'Webhook processing failed');
        return reply.status(500).send({ error: 'Webhook processing failed' });
      }
      return reply.status(200).send({ received: true });
    });
  });

  // GET /billing/ledger — paginated fill records as cost ledger
  app.get<{ Querystring: { limit?: string; offset?: string; botId?: string; agentId?: string; from?: string; to?: string } }>('/billing/ledger', async (request, reply) => {
    const userId = request.userId;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    if (request.query.botId) {
      const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, request.query.botId), eq(bots.userId, userId)));
      if (!bot) return reply.status(404).send({ error: 'not_found', message: 'Bot not found' });
    }

    if (request.query.agentId) {
      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, request.query.agentId), eq(agents.userId, userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found', message: 'Agent not found' });
    }

    const conditions: SQL[] = [];

    if (request.query.botId) {
      conditions.push(and(eq(fills.actorType, 'bot'), eq(fills.actorId, request.query.botId))!);
    } else if (request.query.agentId) {
      // Fills are stored under bot actors — resolve bot IDs managed by this agent.
      const agentBots = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, request.query.agentId)));
      const agentBotIds = agentBots.map((b) => b.id);
      if (agentBotIds.length === 0) {
        return reply.send({ records: [], limit, offset });
      }
      conditions.push(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, agentBotIds))!);
    } else {
      // No specific entity filter — scope to all fills owned by the authenticated user's
      // bots and agents to prevent cross-user data exposure.
      const [userBots, userAgents] = await Promise.all([
        db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId)),
        db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId)),
      ]);
      const botIds = userBots.map((b) => b.id);
      const agentIds = userAgents.map((a) => a.id);

      if (botIds.length === 0 && agentIds.length === 0) {
        return reply.send({ records: [], limit, offset });
      }

      const ownershipConditions: SQL[] = [];
      if (botIds.length > 0) {
        ownershipConditions.push(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds))!);
      }
      if (agentIds.length > 0) {
        ownershipConditions.push(and(eq(fills.actorType, 'agent'), inArray(fills.actorId, agentIds))!);
      }
      const ownerWhere = ownershipConditions.length === 1
        ? ownershipConditions[0]!
        : or(...ownershipConditions)!;
      conditions.push(ownerWhere);
    }

    if (request.query.from) {
      conditions.push(gte(fills.filledAt, new Date(request.query.from)));
    }
    if (request.query.to) {
      conditions.push(lte(fills.filledAt, new Date(request.query.to)));
    }

    const where = and(...conditions);

    const records = await db.select().from(fills)
      .where(where)
      .orderBy(desc(fills.filledAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ records, limit, offset });
  });
}

// --- Helpers ---

function resolveDisplayInfo(
  config: BillingConfig,
  provider: string,
  externalId: string,
): { displayLabel: string; interval: string } | null {
  if (provider === 'stripe') {
    for (const prices of Object.values(config.stripe.planPrices)) {
      const match = prices.find((p) => p.stripePriceId === externalId);
      if (match) return { displayLabel: match.displayLabel, interval: match.interval };
    }
  } else if (provider === 'creem') {
    for (const products of Object.values(config.creem.planProducts)) {
      const match = products.find((p) => p.creemProductId === externalId);
      if (match) return { displayLabel: match.displayLabel, interval: match.interval };
    }
  }
  return null;
}

function resolveIntervalFromPriceId(config: BillingConfig, planId: string, priceId: string): 'month' | 'year' | undefined {
  const stripeMatch = config.stripe.planPrices[planId]?.find((p) => p.stripePriceId === priceId);
  if (stripeMatch) return stripeMatch.interval;
  const creemMatch = config.creem.planProducts[planId]?.find((p) => p.creemProductId === priceId);
  if (creemMatch) return creemMatch.interval;
  return undefined;
}

function resolveTargetId(config: BillingConfig, provider: BillingProvider, planId: string): string | null {
  if (provider === 'stripe') {
    const prices = config.stripe.planPrices[planId];
    return prices?.[0]?.stripePriceId ?? null;
  }
  if (provider === 'mock') {
    return `mock_product_${planId}`;
  }
  const products = config.creem.planProducts[planId];
  return products?.[0]?.creemProductId ?? null;
}

/** Confirms a caller-supplied priceId is a real entry in config for the given planId.
 * When provider is specified, only that provider's IDs are accepted (used by the upgrade route
 * to prevent a Creem product ID from being accepted for a Stripe-owned subscription). */
function isPriceIdValidForPlan(config: BillingConfig, planId: string, priceId: string, provider?: 'creem' | 'stripe' | 'mock'): boolean {
  if (!provider || provider === 'stripe') {
    if (config.stripe.planPrices[planId]?.some((p) => p.stripePriceId === priceId)) return true;
  }
  if (!provider || provider === 'creem') {
    if (config.creem.planProducts[planId]?.some((p) => p.creemProductId === priceId)) return true;
  }
  if (!provider || provider === 'mock') {
    if (priceId === `mock_product_${planId}`) return true;
  }
  return false;
}
