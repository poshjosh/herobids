import type { FastifyInstance } from 'fastify';
import type { BillingConfig, BillingProvider, PlansConfig, UsageBillingConfig, ProvidersYaml } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { BillingRepository, UsageBillingRepository, users, fills, bots, agents, agentRuntimeSessions, billingPeriods } from '@herobids/db';
import { eq, and, desc, gte, lte, inArray, or, type SQL } from 'drizzle-orm';
import { createProviderManager } from '../billing/provider-manager.js';
import { EntitlementSync } from '../billing/entitlement-sync.js';
import { CreemSignatureError } from '../billing/creem-provider.js';
import { StripeSignatureError } from '../billing/stripe-client.js';
import { UnknownWebhookEventTypeError } from '../billing/provider-port.js';
import { MockProvider } from '../billing/mock-provider.js';
import { errorPayload } from '../error-payload.js';

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
  frontendOrigin: string,
  usageBillingConfig?: UsageBillingConfig,
  providersYaml?: ProvidersYaml,
) {
  const billingBase = `${frontendOrigin}/billing`;
  const successUrl = `${billingBase}?session=success`;
  const cancelUrl = `${billingBase}?session=cancelled`;

  const billingRepo = new BillingRepository(db);
  const usageBillingRepo = new UsageBillingRepository(db, usageBillingConfig?.defaultRateCardItems, providersYaml);
  const providerManager = createProviderManager(billingConfig, billingRepo);
  const entitlementSync = new EntitlementSync(
    billingRepo,
    billingConfig,
    plansConfig.defaultPlanId,
    usageBillingRepo,
    usageBillingConfig?.defaultRateCardName,
    plansConfig,
  );

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
      return reply.status(400).send(errorPayload('billing.checkout.plan_id_required', 'planId is required'));
    }

    // Validate plan exists in plans config
    if (!(targetPlanId in plansConfig.plans)) {
      return reply.status(400).send(
        errorPayload('billing.checkout.invalid_plan_id', 'Invalid planId — not found in plans configuration', { planId: targetPlanId }),
      );
    }

    // Validate priceId belongs to the requested plan, scoped to the primary provider
    // (prevents cross-provider IDs reaching an adapter that cannot resolve them).
    if (targetPriceId !== undefined && !isPriceIdValidForPlan(billingConfig, targetPlanId, targetPriceId, billingConfig.primaryProvider)) {
      return reply.status(400).send(
        errorPayload('billing.checkout.invalid_price_id', `priceId is not valid for plan '${targetPlanId}'`, {
          planId: targetPlanId,
          priceId: targetPriceId,
          provider: billingConfig.primaryProvider,
        }),
      );
    }

    // Fetch user info
    const [user] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send(errorPayload('billing.user_not_found', 'User not found'));
    }

    const { url, provider } = await providerManager.createCheckoutUrl({
      userId,
      email: user.email,
      planId: targetPlanId,
      priceId: targetPriceId,
      interval: targetPriceId ? resolveIntervalFromPriceId(billingConfig, targetPlanId, targetPriceId) : undefined,
      successUrl: successUrl,
      cancelUrl: cancelUrl,
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
      return reply.status(400).send(
        errorPayload('billing.portal.no_billing_account', 'No billing account found. Please start a subscription first.'),
      );
    }
    const customer = await billingRepo.findCustomerByUserIdAndProvider(userId, subscription.provider);
    if (!customer) {
      return reply.status(400).send(
        errorPayload('billing.portal.no_billing_account', 'No billing account found. Please start a subscription first.'),
      );
    }

    const url = await providerManager.createPortalUrl(
      {
        customerId: customer.externalCustomerId,
        returnUrl: frontendOrigin,
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
      return reply.status(400).send(errorPayload('billing.cancel.no_active_subscription', 'No active subscription found'));
    }

    if (subscription.status === 'canceled') {
      return reply.status(400).send(errorPayload('billing.cancel.already_canceled', 'Subscription is already canceled'));
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
      return reply.status(400).send(errorPayload('billing.upgrade.plan_id_required', 'planId is required'));
    }

    if (!(newPlanId in plansConfig.plans)) {
      return reply.status(400).send(
        errorPayload('billing.upgrade.invalid_plan_id', 'Invalid planId — not found in plans configuration', { planId: newPlanId }),
      );
    }

    const subscription = await billingRepo.findSubscriptionByUserId(userId);
    if (!subscription) {
      return reply.status(400).send(
        errorPayload('billing.upgrade.no_active_subscription', 'No active subscription found. Use checkout to subscribe.'),
      );
    }

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      return reply.status(400).send(
        errorPayload('billing.upgrade.subscription_not_upgradeable', 'Subscription must be active or trialing to upgrade', {
          status: subscription.status,
        }),
      );
    }

    // Resolve owning provider first so priceId validation is scoped to the correct provider.
    const provider = subscription.provider as BillingProvider;
    // Validate priceId against the owning provider only — prevents cross-provider ID injection.
    if (newPriceId !== undefined && !isPriceIdValidForPlan(billingConfig, newPlanId, newPriceId, provider)) {
      return reply.status(400).send(
        errorPayload('billing.upgrade.invalid_price_id', `priceId is not valid for plan '${newPlanId}' with provider '${provider}'`, {
          planId: newPlanId,
          priceId: newPriceId,
          provider,
        }),
      );
    }

    const newProductOrPriceId = newPriceId ?? resolveTargetId(billingConfig, provider, newPlanId);
    if (!newProductOrPriceId) {
      return reply.status(400).send(
        errorPayload('billing.upgrade.missing_provider_mapping', `No ${provider} mapping for plan '${newPlanId}'`, {
          planId: newPlanId,
          provider,
        }),
      );
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
        return reply.status(404).send(errorPayload('billing.webhook.provider_not_configured', 'Stripe provider not configured', { provider: 'stripe' }));
      }

      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send(errorPayload('billing.webhook.missing_body', 'Missing request body'));
      }

      let event;
      try {
        event = stripeProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof StripeSignatureError) {
          app.log.warn({ err: err.message }, 'Stripe webhook signature verification failed');
          return reply.status(400).send(errorPayload('billing.webhook.invalid_signature', 'Invalid signature', { provider: 'stripe' }));
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
        return reply.status(500).send(errorPayload('billing.webhook.processing_failed', 'Webhook processing failed', { provider: 'stripe' }));
      }
      return reply.status(200).send({ received: true });
    });

    // POST /billing/webhook/creem
    sub.post('/billing/webhook/creem', async (request, reply) => {
      const creemProvider = providerManager?.getProvider('creem');
      if (!creemProvider) {
        return reply.status(404).send(errorPayload('billing.webhook.provider_not_configured', 'Creem provider not configured', { provider: 'creem' }));
      }

      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send(errorPayload('billing.webhook.missing_body', 'Missing request body'));
      }

      let event;
      try {
        event = creemProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof CreemSignatureError) {
          app.log.warn({ err: err.message }, 'Creem webhook signature verification failed');
          return reply.status(400).send(errorPayload('billing.webhook.invalid_signature', 'Invalid signature', { provider: 'creem' }));
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
        return reply.status(500).send(errorPayload('billing.webhook.processing_failed', 'Webhook processing failed', { provider: 'creem' }));
      }
      return reply.status(200).send({ received: true });
    });

    // POST /billing/webhook — alias for primary provider
    sub.post('/billing/webhook', async (request, reply) => {
      if (providerManager.primaryProvider.name === 'mock') {
        return reply.status(404).send(errorPayload('billing.webhook.mock_not_supported', 'No external webhook endpoint when using mock provider'));
      }
      const rawBody = request.body;
      if (!rawBody || typeof rawBody !== 'string') {
        return reply.status(400).send(errorPayload('billing.webhook.missing_body', 'Missing request body'));
      }

      let event;
      try {
        event = providerManager.primaryProvider.verifyWebhook(rawBody, request.headers as Record<string, string>);
      } catch (err) {
        if (err instanceof StripeSignatureError || err instanceof CreemSignatureError) {
          app.log.warn({ err: (err as Error).message }, 'Webhook signature verification failed');
          return reply.status(400).send(
            errorPayload('billing.webhook.invalid_signature', 'Invalid signature', { provider: providerManager.primaryProvider.name }),
          );
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
        return reply.status(500).send(
          errorPayload('billing.webhook.processing_failed', 'Webhook processing failed', { provider: providerManager.primaryProvider.name }),
        );
      }
      return reply.status(200).send({ received: true });
    });
  });

  // GET /trading/fills — paginated fill records (trading cost ledger; renamed from /billing/ledger)
  app.get<{ Querystring: { limit?: string; offset?: string; botId?: string; agentId?: string; from?: string; to?: string } }>('/trading/fills', async (request, reply) => {
    const userId = request.userId;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    if (request.query.botId) {
      const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, request.query.botId), eq(bots.userId, userId)));
      if (!bot) return reply.status(404).send(errorPayload('billing.ledger.bot_not_found', 'Bot not found', { botId: request.query.botId }));
    }

    if (request.query.agentId) {
      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, request.query.agentId), eq(agents.userId, userId)));
      if (!agent) return reply.status(404).send(errorPayload('billing.ledger.agent_not_found', 'Agent not found', { agentId: request.query.agentId }));
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

  // ---------------------------------------------------------------------------
  // GET /billing/usage-summary — current period headline numbers
  // ---------------------------------------------------------------------------
  app.get('/billing/usage-summary', async (request, reply) => {
    const userId = request.userId;

    const account = await usageBillingRepo.getAccountByUserId(userId);
    if (!account) {
      return reply.send({
        account: null,
        currentPeriod: null,
        warnings: [],
        byMeter: {},
      });
    }

    const summary = await usageBillingRepo.getUsageSummary(account.id);
    const period = summary?.period ?? null;
    const byMeterRows = period
      ? await usageBillingRepo.getByMeterBreakdown(account.id, {
          from: period.periodStart,
          to: period.periodEnd,
        })
      : [];

    const warningThresholds = usageBillingConfig?.warningThresholdsPct ?? [50, 80, 100];
    const netOutOfPocket = period ? Math.max(0, -period.balanceMicrousd) : 0;
    const hardCap = period?.hardCapMicrousd;
    const planUsage = plansConfig.plans[account.activePlanId]?.usage;
    const allowedPackIds = new Set(planUsage?.topUpPackIds ?? []);
    const topUpsEnabled = (planUsage?.topUpPackIds?.length ?? 0) > 0 && Boolean(usageBillingConfig?.creditTopUpsEnabled);
    const topUpPacks = topUpsEnabled && usageBillingConfig
      ? Object.entries(usageBillingConfig.topUpProductsByProvider).flatMap(([provider, packs]) =>
          providerManager.getProvider(provider as BillingProvider)
            ? packs
                .filter((pack) => allowedPackIds.has(pack.packId))
                .map((pack) => ({
                  provider,
                  packId: pack.packId,
                  cents: pack.cents,
                }))
            : [],
        )
      : [];
    const warnings = warningThresholds.map((pct) => ({
      thresholdPct: pct,
      reached: hardCap != null ? netOutOfPocket >= (hardCap * pct) / 100 : false,
    }));

    return reply.send({
      account: {
        id: account.id,
        status: account.status,
        currency: account.currency,
        activePlanId: account.activePlanId,
      },
      currentPeriod: period
        ? {
            id: period.id,
            periodStart: period.periodStart.toISOString(),
            periodEnd: period.periodEnd.toISOString(),
            includedCreditMicrousd: period.includedCreditMicrousd,
            usageChargeMicrousd: period.usageChargeMicrousd,
            creditAppliedMicrousd: period.creditAppliedMicrousd,
            balanceMicrousd: period.balanceMicrousd,
            softCapMicrousd: period.softCapMicrousd ?? null,
            hardCapMicrousd: period.hardCapMicrousd ?? null,
          }
        : null,
      warnings,
      topUpPacks,
      byMeter: Object.fromEntries(
        byMeterRows.map((r) => [r.meterKey, { quantity: r.totalQuantity, chargeMicrousd: r.chargeMicrousd }]),
      ),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /billing/usage-events — paginated commercial usage events
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      meterKey?: string;
      agentId?: string;
      sessionId?: string;
      periodId?: string;
      from?: string;
      to?: string;
    };
  }>('/billing/usage-events', async (request, reply) => {
    const userId = request.userId;

    const account = await usageBillingRepo.getAccountByUserId(userId);
    if (!account) {
      return reply.send({ records: [], total: 0, limit: 50, offset: 0 });
    }

    const limitRaw = Number.parseInt(request.query.limit ?? '50', 10);
    const offsetRaw = Number.parseInt(request.query.offset ?? '0', 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    if (request.query.meterKey && !BILLABLE_METER_KEYS.has(request.query.meterKey)) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_meter_key', 'meterKey must be one of the known billable meters', {
        meterKey: request.query.meterKey,
      }));
    }

    const fromDate = parseIsoDate(request.query.from);
    if (request.query.from && !fromDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_from', 'from must be a valid ISO-8601 date-time string'));
    }
    const toDate = parseIsoDate(request.query.to);
    if (request.query.to && !toDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_to', 'to must be a valid ISO-8601 date-time string'));
    }
    if (fromDate && toDate && fromDate > toDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_range', 'from must be less than or equal to to'));
    }

    if (request.query.periodId) {
      const [period] = await db
        .select({ id: billingPeriods.id })
        .from(billingPeriods)
        .where(and(eq(billingPeriods.id, request.query.periodId), eq(billingPeriods.accountId, account.id)))
        .limit(1);
      if (!period) {
        return reply.status(404).send(errorPayload('billing.usage.period_not_found', 'Billing period not found', { periodId: request.query.periodId }));
      }
    }

    // Validate agentId ownership
    if (request.query.agentId) {
      const [agent] = await db.select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, request.query.agentId), eq(agents.userId, userId)))
        .limit(1);
      if (!agent) {
        return reply.status(404).send(errorPayload('billing.usage.agent_not_found', 'Agent not found', { agentId: request.query.agentId }));
      }
    }

    // Validate sessionId ownership (session agent must belong to user)
    if (request.query.sessionId) {
      const [session] = await db
        .select({ id: agentRuntimeSessions.id })
        .from(agentRuntimeSessions)
        .innerJoin(agents, eq(agentRuntimeSessions.agentId, agents.id))
        .where(
          and(
            eq(agentRuntimeSessions.id, request.query.sessionId),
            eq(agents.userId, userId),
          ),
        )
        .limit(1);
      if (!session) {
        return reply.status(404).send(errorPayload('billing.usage.session_not_found', 'Session not found', { sessionId: request.query.sessionId }));
      }
    }

    const { rows, total } = await usageBillingRepo.listUsageEvents(account.id, {
      limit,
      offset,
      meterKey: request.query.meterKey,
      agentId: request.query.agentId,
      sessionId: request.query.sessionId,
      periodId: request.query.periodId,
      from: fromDate ?? undefined,
      to: toDate ?? undefined,
    });

    return reply.send({
      records: rows.map((r) => ({
        id: r.event.id,
        occurredAt: r.event.occurredAt.toISOString(),
        meterKey: r.event.meterKey,
        quantity: r.event.quantity,
        unit: r.event.unit,
        chargeMicrousd: r.chargeMicrousd,
        currency: r.currency,
        provider: r.event.provider ?? null,
        model: r.event.model ?? null,
        metadata: r.event.metadata ?? {},
        agent: r.event.agentId
          ? { id: r.event.agentId, name: r.agentName ?? r.event.agentId }
          : null,
        session: r.event.sessionId
          ? { id: r.event.sessionId, status: r.sessionStatus ?? null }
          : null,
      })),
      total,
      limit,
      offset,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /billing/usage-breakdown — spend by agent and by meter
  // ---------------------------------------------------------------------------
  app.get<{
    Querystring: {
      periodId?: string;
      from?: string;
      to?: string;
    };
  }>('/billing/usage-breakdown', async (request, reply) => {
    const userId = request.userId;

    const account = await usageBillingRepo.getAccountByUserId(userId);
    if (!account) {
      return reply.send({ byAgent: [], byMeter: [], bySkill: [] });
    }

    const fromDate = parseIsoDate(request.query.from);
    if (request.query.from && !fromDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_from', 'from must be a valid ISO-8601 date-time string'));
    }
    const toDate = parseIsoDate(request.query.to);
    if (request.query.to && !toDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_to', 'to must be a valid ISO-8601 date-time string'));
    }
    if (fromDate && toDate && fromDate > toDate) {
      return reply.status(400).send(errorPayload('billing.usage.invalid_range', 'from must be less than or equal to to'));
    }

    if (request.query.periodId) {
      const [period] = await db
        .select({ id: billingPeriods.id })
        .from(billingPeriods)
        .where(and(eq(billingPeriods.id, request.query.periodId), eq(billingPeriods.accountId, account.id)))
        .limit(1);
      if (!period) {
        return reply.status(404).send(errorPayload('billing.usage.period_not_found', 'Billing period not found', { periodId: request.query.periodId }));
      }
    }

    const filters = {
      periodId: request.query.periodId,
      from: fromDate ?? undefined,
      to: toDate ?? undefined,
    };

    const [byAgentRows, byMeterRows] = await Promise.all([
      usageBillingRepo.getByAgentBreakdown(account.id, filters),
      usageBillingRepo.getByMeterBreakdown(account.id, filters),
    ]);

    return reply.send({
      byAgent: byAgentRows
        .filter((r) => r.agentId != null)
        .map((r) => ({
          agentId: r.agentId,
          agentName: r.agentName ?? r.agentId,
          quantity: r.totalQuantity,
          chargeMicrousd: r.chargeMicrousd,
        })),
      byMeter: byMeterRows.map((r) => ({
        meterKey: r.meterKey,
        quantity: r.totalQuantity,
        chargeMicrousd: r.chargeMicrousd,
      })),
      bySkill: [],
    });
  });

  // ---------------------------------------------------------------------------
  // GET /billing/periods — current and historical billing periods
  // ---------------------------------------------------------------------------
  app.get('/billing/periods', async (request, reply) => {
    const userId = request.userId;

    const account = await usageBillingRepo.getAccountByUserId(userId);
    if (!account) {
      return reply.send({ periods: [] });
    }

    const periods = await usageBillingRepo.listPeriods(account.id);

    return reply.send({
      periods: periods.map((p) => ({
        id: p.id,
        status: p.status,
        periodStart: p.periodStart.toISOString(),
        periodEnd: p.periodEnd.toISOString(),
        usageChargeMicrousd: p.usageChargeMicrousd,
        includedCreditMicrousd: p.includedCreditMicrousd,
        balanceMicrousd: p.balanceMicrousd,
      })),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /billing/spend-caps — set soft and hard spend caps for the account
  // ---------------------------------------------------------------------------
  app.post<{ Body: { softCapCents?: number | null; hardCapCents?: number | null } }>(
    '/billing/spend-caps',
    async (request, reply) => {
      const userId = request.userId;
      const { softCapCents, hardCapCents } = request.body as {
        softCapCents?: number | null;
        hardCapCents?: number | null;
      };

      const account = await usageBillingRepo.getAccountByUserId(userId);
      if (!account) {
        return reply.status(404).send(errorPayload('billing.account_not_found', 'Billing account not found'));
      }

      // Validate caps are non-negative and hardCap >= softCap when both set
      if (softCapCents != null && softCapCents < 0) {
        return reply.status(400).send(errorPayload('billing.caps.invalid', 'softCapCents must be non-negative'));
      }
      if (hardCapCents != null && hardCapCents < 0) {
        return reply.status(400).send(errorPayload('billing.caps.invalid', 'hardCapCents must be non-negative'));
      }
      if (softCapCents != null && hardCapCents != null && hardCapCents < softCapCents) {
        return reply.status(400).send(errorPayload('billing.caps.invalid', 'hardCapCents must be greater than or equal to softCapCents'));
      }

      // Convert cents to microusd (1 cent = 10_000 microusd)
      await usageBillingRepo.setSpendCaps(account.id, {
        softCapMicrousd: softCapCents != null ? softCapCents * 10_000 : null,
        hardCapMicrousd: hardCapCents != null ? hardCapCents * 10_000 : null,
      });
      const status = await usageBillingRepo.recomputeSpendState(account.id);

      return reply.send({ success: true, status });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /billing/top-up-checkout-session — purchase a credit top-up pack
  // ---------------------------------------------------------------------------
  app.post<{ Body: { packId: string } }>(
    '/billing/top-up-checkout-session',
    async (request, reply) => {
      if (!usageBillingConfig?.creditTopUpsEnabled) {
        return reply.status(400).send(errorPayload('billing.top_up.not_enabled', 'Credit top-ups are not enabled'));
      }

      const { packId } = request.body as { packId?: string };
      if (!packId || typeof packId !== 'string') {
        return reply.status(400).send(errorPayload('billing.top_up.pack_id_required', 'packId is required'));
      }

      const userId = request.userId;
      const account = await usageBillingRepo.getAccountByUserId(userId);
      const planId = account?.activePlanId ?? (await usageBillingRepo.getUserPlanId(userId)) ?? plansConfig.defaultPlanId;
      const planUsage = plansConfig.plans[planId]?.usage;
      if ((planUsage?.topUpPackIds?.length ?? 0) === 0) {
        return reply.status(400).send(errorPayload('billing.top_up_required', 'Top-ups are not enabled for the current plan', { planId }));
      }

      // Find the pack in operator config
      let matchedPack: { packId: string; externalId: string; cents: number } | null = null;
      let matchedProvider: string | null = null;
      for (const [provider, packs] of Object.entries(usageBillingConfig.topUpProductsByProvider)) {
        if (!providerManager.getProvider(provider as BillingProvider)) {
          continue;
        }
        const pack = packs.find((p) => p.packId === packId);
        if (pack) {
          matchedPack = pack;
          matchedProvider = provider;
          break;
        }
      }

      if (!matchedPack || !matchedProvider) {
        return reply.status(400).send(errorPayload('billing.top_up.unknown_pack', 'Unknown top-up pack', { packId }));
      }

      if (!planUsage?.topUpPackIds.includes(packId)) {
        return reply.status(400).send(errorPayload('billing.top_up.pack_not_allowed_for_plan', 'This top-up pack is not available on the current plan', {
          packId,
          planId,
        }));
      }

      const [user] = await db
        .select({ email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send(errorPayload('billing.user_not_found', 'User not found'));
      }

      // Create a one-time checkout session for the top-up pack via the matched provider
      const { url, provider } = await providerManager.createCheckoutUrlViaProvider({
        userId,
        email: user.email,
        planId: `top_up_${packId}`,
        priceId: matchedPack.externalId,
        successUrl: successUrl,
        cancelUrl: cancelUrl,
        metadata: {
          displayName: user.displayName,
          topUpPackId: packId,
          topUpCents: String(matchedPack.cents),
          checkoutKind: 'top_up',
        },
      }, matchedProvider as BillingProvider);

      if (provider === 'mock') {
        const mockProvider = providerManager.getProvider('mock') as MockProvider;
        const syntheticTopUpEvent = mockProvider.createSyntheticTopUpEvent({
          userId,
          packId,
          cents: matchedPack.cents,
        });
        await entitlementSync.processEvent(syntheticTopUpEvent);
      }

      return reply.send({ url, provider });
    },
  );
}

const BILLABLE_METER_KEYS = new Set([
  'llm.input_tokens',
  'llm.cached_input_tokens',
  'llm.output_tokens',
  'llm.reasoning_tokens',
  'agent.runtime_ms',
]);

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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
