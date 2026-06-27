import pino from 'pino';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { WorkerRuntime, QUEUE_NAME } from './runtime.js';
import type { PersistedInstance } from './runtime.js';
import { BacktestRuntime } from './backtest-runtime.js';
import { InstanceLease } from './instance-lease.js';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import type { ExecutionActor } from './execution-actor.js';
import { VenueAdapterFactory } from './venue-adapter-factory.js';
import { AgentTradingActor } from './agent-trading-actor.js';
import { createSwapTokenSafetyAdapter } from './token-safety-adapter.js';
import { ActorStateOwner } from './agents/actor-state-owner.js';
import { LlmStrategy, MechanicalStrategy, HybridStrategy, DcaStrategy } from '@herobids/strategy';
import { fetchOpenRouterPricing } from '@herobids/llm';
import { MarketDataRecorder } from '@herobids/backtesting';
import { createDatabase, PgJournal, FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, ReconciliationEventRepository, DecisionRepository, BacktestingRepository, AlertDeliveryRepository, AgentRepository, BotRepository, TokenSafetyOverrideRepository, UsageBillingRepository, DecisionFailureRepository, bots, users } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { PublicStreamPool, OracleMarkSource, VenueCandleFetcher } from '@herobids/venues';
import type { IdGenerator } from '@herobids/engine';
import { LastFillMarkSource, MarkSelector } from '@herobids/engine';
import type { DecisionContext } from '@herobids/engine';
import { quantity, price, BotConfigSchema, ACTOR_HEALTH_TTL_SECONDS, loadProvidersConfig, type ProvidersYaml } from '@herobids/domain';
import type { MarketSnapshot, OrderId, FillId, Strategy, StrategyConfig, OrderbookVenuePort, SwapVenuePort, CandleFetcher } from '@herobids/domain';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { assertLiveReadiness, LiveGateError } from './live-gate.js';
import { resolveSwapAssetsFromBinding, resolveSwapNetwork } from './resolve-swap-assets.js';
import { resolveBotStartupContext, BotStartupError } from './startup-context.js';
import { buildPublicStreamConnectors, createScopedStreamPoolHandle } from './public-stream-routing.js';
import { AlertDispatcher } from './alerting/index.js';
import { TelegramClient, forceReply, PlatformAlertService, ResendEmailClient } from './alerting/index.js';
import {
  AgentMessageBroker,
  AgentDecisionHandler,
  AgentIntakeResolver,
  AgentRuntimeLauncher,
  AgentSessionManager,
  AgentStreamConsumer,
  AgentHealthMonitor,
  AgentReconnectHandler,
  InstanceEventPublisher,
} from './agents/index.js';
import type { DecisionIntakeResolver, ContextSnapshotResolver } from './agents/index.js';
import { UserEventPublisher } from './user-event-publisher.js';
import { ActorHealthPublisher } from './actor-health-publisher.js';
import { createMarketDataCoordinator, createMarketMonitor } from './market-intelligence/index.js';
import { createProviderRegistry, lookupCanonical, resolveTokenSafetyPolicyConfig, type RedisEvalClient, type TokenInfo } from '@herobids/market-data';
import { ReminderCoordinator } from './reminder-coordinator.js';
import type { ResolvedSwapTokenData } from './token-safety-adapter.js';
import { resolveSwapTokenData, type DexScreenerProvider, type CanonicalResolver } from './swap-token-resolver.js';
import { buildAgentRiskLimits } from './agent-risk-limits.js';

async function enrichTokenWithDiscovery(
  registry: ReturnType<typeof createProviderRegistry>,
  network: string,
  resolvedAddress: string,
  match: TokenInfo,
): Promise<ResolvedSwapTokenData> {
  if ((match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt) {
    return { ...match, ageResolution: 'available', hasRealMarketData: true };
  }

  // Try a targeted DexScreener search by address first — this is a direct
  // lookup that returns poolCreatedAt when the upstream API provides it.
  try {
    const directResult = await registry.dexscreener.search(resolvedAddress);
    const directMatch = directResult.data.find((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === resolvedAddress.toLowerCase()
    ));
    if (directMatch) {
      const poolCreatedAt = (directMatch as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt;
      return {
        ...match,
        poolCreatedAt: poolCreatedAt ?? (match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt,
        ageResolution: poolCreatedAt ? 'available' : 'indeterminate',
        hasRealMarketData: true,
      };
    }
  } catch (err) {
    // Fall through to discovery if the direct search fails.
    console.warn('[enrichTokenWithDiscovery] direct DexScreener search failed, falling back to discovery', { network, resolvedAddress, err });
  }

  try {
    // Discovery is a targeted lookup for a specific token address to find
    // poolCreatedAt.  minLiquidityUsd: 0 maximises the chance of finding the
    // token in any pool — safety thresholds are enforced downstream by
    // evaluateTokenSafety, not here.
    const discoveryResult = await registry.discovery.discover({
      networks: [network],
      maxResults: 250,
      minLiquidityUsd: 0,
    });
    const discoveryMatch = discoveryResult.data.find((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === resolvedAddress.toLowerCase()
    ));

    if (!discoveryMatch) {
      return { ...match, ageResolution: 'indeterminate', hasRealMarketData: true };
    }

    return {
      ...match,
      poolCreatedAt: discoveryMatch.poolCreatedAt ?? (match as TokenInfo & { poolCreatedAt?: string }).poolCreatedAt,
      ageResolution: discoveryMatch.poolCreatedAt ? 'available' : 'missing',
      hasRealMarketData: true,
    };
  } catch {
    console.warn('[enrichTokenWithDiscovery] discovery lookup failed for', { network, resolvedAddress });
    return { ...match, ageResolution: 'indeterminate', hasRealMarketData: true };
  }
}

class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

const isPrettyLog = process.env['LOG_FORMAT'] === 'pretty' || process.env['NODE_ENV'] === 'development';
const logger = pino(
  isPrettyLog
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { name: 'herobids-worker' },
);

// Load operator config: default.yaml → {NODE_ENV}.yaml → env var overrides
const appConfig = loadConfig();

// Load provider registry — used by UsageBillingRepository for per-model rate card seeding
const providersYaml = loadProvidersConfig('config/providers.yaml');

// Parse Redis connection from operator config URL — preserving auth, TLS, and DB index
const parsedRedisUrl = new URL(appConfig.redis.url);
const redisConnection = {
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.username && { username: decodeURIComponent(parsedRedisUrl.username) }),
  ...(parsedRedisUrl.pathname && parsedRedisUrl.pathname !== '/' && { db: parseInt(parsedRedisUrl.pathname.slice(1), 10) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
};

// Redis client for lease management (separate from BullMQ's internal connection)
const redisClient = new Redis(redisConnection);
let botStopSubscriber: Redis | undefined;
let agentCleanupSubscriber: Redis | undefined;
const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
const lease = new InstanceLease(redisClient, workerId, 30);

const db = createDatabase(appConfig.database.url);
const journal = new PgJournal(db);
const fillRepo = new FillRepository(db);
const positionRepo = new PositionRepository(db);
const planRepo = new ExecutionPlanRepository(db);
const orderRepo = new OrderRepository(db);
const balanceSnapshotRepo = new BalanceSnapshotRepository(db);
const reconciliationRepo = new ReconciliationEventRepository(db);
const decisionRepo = new DecisionRepository(db);
const backtestingRepo = new BacktestingRepository(db);
const alertDeliveryRepo = new AlertDeliveryRepository(db);
const tokenSafetyOverrideRepo = new TokenSafetyOverrideRepository(db);
const decisionFailureRepo = new DecisionFailureRepository(db);

const sharedMarketDataRegistry = appConfig.marketData
  ? createProviderRegistry(appConfig.marketData, { redisClient: redisClient as unknown as RedisEvalClient, discoverySeenClient: redisClient })
  : undefined;

// The outer guard (appConfig.marketData && sharedMarketDataRegistry) prevents
// creation when the registry is absent. The inner null-check defends against
// a theoretical edge case where the closure is invoked after the module-level
// variable is reassigned (capture-by-reference, not by value).
const swapTokenSafety = appConfig.marketData && sharedMarketDataRegistry
  ? createSwapTokenSafetyAdapter({
      marketDataConfig: appConfig.marketData,
      overrideRepo: tokenSafetyOverrideRepo,
      resolveTokenData: async (network, tokenAddress) => {
        if (!sharedMarketDataRegistry || !appConfig.marketData) {
          return null;
        }
        const canonicalResolver: CanonicalResolver = {
          resolve: (symbol, net) => {
            const policy = resolveTokenSafetyPolicyConfig(appConfig.marketData!);
            return lookupCanonical(symbol, net, policy.canonicalTokens);
          },
        };
        const dexScreenerProvider: DexScreenerProvider = {
          search: (addr) => sharedMarketDataRegistry.dexscreener.search(addr),
        };
        const result = await resolveSwapTokenData(
          dexScreenerProvider, network, tokenAddress, canonicalResolver,
        );
        if (!result) return null;
        // Enrich with discovery data when pool creation timestamp is missing
        // from the DexScreener result (handled by the resolver for canonical
        // synthetic fallback, needed only for live DexScreener matches).
        if (!result.poolCreatedAt && result.hasRealMarketData) {
          return enrichTokenWithDiscovery(sharedMarketDataRegistry, network, result.address, result);
        }
        return result;
      },
    })
  : undefined;

// Agent subsystem — registry + protocol stack. Created before WorkerRuntime so the
// actor factory can subscribe streams and register actors on creation.
const actorRegistry = new Map<string, ExecutionActor>();
const agentState = new ActorStateOwner(actorRegistry);
/** Maps botId → userId so the onStarted/onStartFailed callbacks can publish events. */
const instanceUserIds = new Map<string, string>();
/** Maps botId → execution mode for health snapshots. */
const instanceExecutionModes = new Map<string, 'paper' | 'shadow' | 'live'>();
const agentRepo = new AgentRepository(db);
const eventPublisher = new InstanceEventPublisher(redisClient);
const userEventPublisher = new UserEventPublisher(redisClient);
const actorHealthPublisher = new ActorHealthPublisher(redisClient);

// ID generator using UUIDv7 (crypto.randomUUID as fallback)
const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
  orderId: () => crypto.randomUUID() as OrderId,
  fillId: () => crypto.randomUUID() as FillId,
  planId: () => crypto.randomUUID(),
  decisionId: () => crypto.randomUUID(),
};

const runtimeMode = (process.env['AGENT_RUNTIME_MODE'] ?? 'stub') as 'docker' | 'stub';
logger.info({ mode: runtimeMode }, 'Agent runtime mode');

if (runtimeMode === 'docker' && !appConfig.llm.provider) {
  logger.fatal('llm.provider config is required when AGENT_RUNTIME_MODE=docker');
  process.exit(1);
}

const agentRuntimeLauncher = runtimeMode === 'docker'
  ? new AgentRuntimeLauncher({
      mode: 'docker',
      agentRepo,
      dockerConfig: {
        dockerHost: process.env['DOCKER_HOST'] ?? 'tcp://docker-proxy:2375',
        dockerNetwork: process.env['DOCKER_NETWORK'] ?? 'herobids_default',
        agentImage: process.env['AGENT_IMAGE'] ?? 'herobids-agent:latest',
        redisUrl: appConfig.redis.url,
        llmProvider: appConfig.llm.provider,
        llmModel: appConfig.llm.model,
        llmBaseUrl: appConfig.llm.baseUrl,
        llmMaxTokens: appConfig.llm.maxTokens,
        llmTimeoutMs: appConfig.llm.timeoutMs,
        llmTickIntervalMs: appConfig.llm.tickIntervalMs,
        llmHeartbeatIntervalMs: appConfig.llm.heartbeatIntervalMs,
        llmServerCostUsdPerHour: appConfig.llm.serverCostUsdPerHour,
        memoryLimitMb: appConfig.agentRuntime.sandboxDefaults.memoryMb,
        cpuShares: appConfig.agentRuntime.sandboxDefaults.cpuShares,
        tempStorageMb: appConfig.agentRuntime.sandboxDefaults.tempStorageMb,
        maxProcesses: appConfig.agentRuntime.sandboxDefaults.maxProcesses,
        agentRuntimeConfigJson: JSON.stringify({
          ...appConfig.agentRuntime,
          llm: {
            retry: appConfig.llm.retry,
            scout: {
              ...appConfig.llm.scout,
              ...appConfig.agentRuntime.llm.scout,
            },
            judge: appConfig.agentRuntime.llm.judge,
            thinking: appConfig.llm.thinking,
          },
        }),
        ...(appConfig.llm.tradingHours
          ? {
              llmTradingHoursJson: JSON.stringify(appConfig.llm.tradingHours),
            }
          : {}),
        ...(appConfig.marketData
          ? {
              marketDataConfigJson: JSON.stringify(appConfig.marketData),
            }
          : {}),
      },
    })
  : new AgentRuntimeLauncher({ redis: redisClient });

// Worker-scoped oracle mark source (stateless, safe to share)
const oracleMarkSource = new OracleMarkSource({
  baseUrl: appConfig.marking.oracleBaseUrl,
  timeoutMs: appConfig.marking.oracleTimeoutMs,
  vsCurrency: appConfig.marking.oracleVsCurrency,
});

const agentIntakeResolver = new AgentIntakeResolver({
  db,
  agentRepo,
  positionRepo,
  decisionRepo,
  planRepo,
  fillRepo,
  orderRepo,
  balanceSnapshotRepo,
  backtestingRepo,
  journal,
  markSource: oracleMarkSource,
  idGen,
  agentRiskDefaults: appConfig.agentRiskDefaults,
  swapTokenSafety,
  oneInchConfig: appConfig.venues['1inch'],
});

const intakeResolver: DecisionIntakeResolver = {
  getIntakeDeps: async (instanceId: string, instrumentId?: string) => {
    const actor = actorRegistry.get(instanceId);
    if (actor?.isRunning) {
      // Refresh actor risk limits from DB so runtime overrides take effect on the next decision
      if (actor.updateRiskLimits) {
        const agent = await agentRepo.getAgent(instanceId);
        if (agent) {
          const freshLimits = buildAgentRiskLimits({
            capital: agent.capital ?? null,
            dailyLossLimit: agent.dailyLossLimit ?? null,
            maxOpenPositions: agent.maxOpenPositions ?? null,
            maxPositionSizePct: agent.maxPositionSizePct ?? null,
            stopLossPct: agent.stopLossPct ?? null,
            stopLossCooldownMs: agent.stopLossCooldownMs ?? null,
          }, appConfig.agentRiskDefaults, (agent.riskOverrides as Record<string, number> | null) ?? {});
          actor.updateRiskLimits(freshLimits);
        }
      }
      return actor.getIntakeDeps(instrumentId);
    }
    if (!agentState.canUseGrantFallback(instanceId)) return undefined;
    // Fallback: resolve as agent via capability grants
    if (instrumentId) return agentIntakeResolver.getIntakeDeps(instanceId, instrumentId);
    return undefined;
  },
  getDecisionContext: (instanceId: string, instrumentId?: string): DecisionContext | undefined | Promise<DecisionContext | undefined> => {
    const actor = actorRegistry.get(instanceId);
    if (actor?.isRunning) return actor.getDecisionContext(instrumentId);
    if (!agentState.canUseGrantFallback(instanceId)) return undefined;
    // Fallback: resolve as agent
    if (instrumentId) return agentIntakeResolver.getDecisionContext(instanceId, instrumentId);
    return undefined;
  },
  getPosition: (instanceId: string, instrumentId?: string) => {
    const actor = actorRegistry.get(instanceId);
    if (actor?.isRunning) return actor.getPosition(instrumentId);
    if (!agentState.canUseGrantFallback(instanceId)) return undefined;
    // Fallback: resolve as agent
    if (instrumentId) return agentIntakeResolver.getPosition(instanceId, instrumentId);
    return undefined;
  },
  recordExecutionOutcome: (instanceId: string, success: boolean) => {
    const actor = actorRegistry.get(instanceId);
    if (actor?.isRunning) actor.recordExecutionOutcome?.(success);
  },
};

const agentDecisionHandler = new AgentDecisionHandler(agentRepo, intakeResolver, eventPublisher, decisionFailureRepo);

const snapshotResolver: ContextSnapshotResolver = {
  resolveSnapshots: async (instanceId: string) => {
    const actor = actorRegistry.get(instanceId);
    if (!actor?.isRunning) return [];
    if (actor instanceof AgentTradingActor) {
      return actor.buildReconnectSnapshots();
    }
    // Bot actors are single-instrument — delegate to single resolver path
    return [];
  },
  resolveSnapshot: async (instanceId: string) => {
    const actor = actorRegistry.get(instanceId);
    if (!actor?.isRunning) return undefined;
    if (actor instanceof AgentTradingActor) {
      return actor.buildReconnectSnapshot();
    }
    if (!(actor instanceof TradingActor)) return undefined;
    const snapshot = actor.getLastSnapshot();
    if (!snapshot) return undefined;
    const pos = actor.currentPosition;

    // Compute per-instrument unrealized PnL when mark/snapshot is available
    let pnl: string | undefined;
    if (pos.side !== 'flat') {
      const markPrice = parseFloat(snapshot.price.toString());
      const entryPrice = parseFloat(pos.entryPrice.toString());
      const size = parseFloat(pos.size.toString());
      const direction = pos.side === 'long' ? 1 : -1;
      const unrealizedPnl = (markPrice - entryPrice) * size * direction;
      if (Number.isFinite(unrealizedPnl)) {
        pnl = unrealizedPnl.toFixed(2);
      }
    }

    return {
      snapshotId: crypto.randomUUID(),
      symbol: snapshot.symbol,
      price: snapshot.price.toString(),
      timestamp: snapshot.timestamp,
      position: pos.side === 'flat' ? null : {
        side: pos.side,
        size: pos.size.toString(),
        entryPrice: pos.entryPrice.toString(),
        realizedPnl: pos.realizedPnl.toString(),
      },
      pnl,
      referenceMark: (() => {
        const lastMark = actor.getLastMarkResult();
        return (lastMark?.ok && !lastMark.data.stale)
          ? { price: lastMark.data.price.toString(), source: lastMark.data.source }
          : { price: snapshot.price.toString(), source: 'snapshot' };
      })(),
      strategyParams: {},
      executionMode: actor.executionMode,
      guardrails: {},
    };
  },
};

const agentReconnectHandler = new AgentReconnectHandler(redisClient, agentRepo, eventPublisher, undefined, snapshotResolver);

// Platform alert service — mandatory safety alerts to users via Telegram.
// Uses the same bot token as the operator alert dispatcher.
const workerTelegram = appConfig.alerts.telegram.botToken
  ? new TelegramClient(appConfig.alerts.telegram.botToken)
  : undefined;

if (!workerTelegram && appConfig.alerts.telegram.webhookUrl) {
  logger.warn(
    'TELEGRAM_WEBHOOK_URL is set but TELEGRAM_BOT_TOKEN is not — the webhook endpoint will receive updates but the app cannot send messages or register the webhook.',
  );
}

if (workerTelegram && !appConfig.alerts.telegram.webhookUrl) {
  logger.warn(
    'TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_URL is not — inbound Telegram messages (user replies) will NOT reach the app. ' +
    'Set TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET to enable two-way messaging.',
  );
}

if (workerTelegram && appConfig.alerts.telegram.webhookUrl) {
  if (!appConfig.alerts.telegram.webhookSecret) {
    logger.warn('alerts.telegram.webhookUrl is configured without alerts.telegram.webhookSecret; skipping Telegram webhook registration');
  } else {
    const webhookResult = await workerTelegram.setWebhook(
      appConfig.alerts.telegram.webhookUrl,
      appConfig.alerts.telegram.webhookSecret,
    );
    if (!webhookResult.ok) {
      logger.warn({ error: webhookResult.error }, 'Failed to register Telegram webhook');
    } else {
      logger.info({ url: appConfig.alerts.telegram.webhookUrl }, 'Registered Telegram webhook');
    }
  }
}
const platformAlerts = new PlatformAlertService(agentRepo, workerTelegram, appConfig.alerts.telegram.botToken || undefined);

// Email client for agent send_message email fanout — disabled by default.
const workerEmail = appConfig.alerts.email.apiKey && appConfig.alerts.email.fromEmail
  ? new ResendEmailClient(
      appConfig.alerts.email.apiKey,
      appConfig.alerts.email.fromEmail,
      {
        replyToEmail: appConfig.alerts.email.replyToEmail,
        timeoutMs: appConfig.alerts.email.timeoutMs,
      },
    )
  : undefined;

async function sendSessionStartedTelegramAnchor(agentId: string, sessionId: string): Promise<void> {
  if (!workerTelegram) {
    return;
  }

  const agent = await agentRepo.getAgent(agentId);
  if (!agent) {
    return;
  }

  const telegramChatId = await agentRepo.getEffectiveTelegramChatId(agentId);
  if (!telegramChatId) {
    return;
  }

  const text = `${agent.name} is now running. Reply to this message to send it instructions.`;
  const outboundMessageId = await agentRepo.insertOutboundMessage({
    agentId,
    sessionId,
    authoredBy: 'platform',
    subject: 'Session started',
    body: text,
    messageClass: 'reminder',
  });

  const result = await workerTelegram.sendText(telegramChatId, text, forceReply());
  if (!result.ok) {
    await agentRepo.markOutboundMessageFailed(outboundMessageId, result.error.message).catch(() => undefined);
    logger.warn({ agentId, error: result.error }, 'Failed to send Telegram session-started anchor');
    return;
  }

  await agentRepo.markOutboundMessageSent(outboundMessageId, String(result.data.messageId), telegramChatId).catch(() => undefined);
}

// Late-bound subscribe callback: set once agentStreamConsumer is constructed below.
// sessionManager.reconcileStartingSessions() only runs after sessionManager.start()
// (line ~749), by which point agentStreamConsumer is fully initialized.
let agentStreamSubscribeFn: ((agentId: string) => Promise<void>) | undefined;

const sessionManager = new AgentSessionManager(agentRepo, eventPublisher, agentRuntimeLauncher, {
  // bug-008: reduced from default 10 000 ms to 2 000 ms so agents start within
  // ~2 s instead of up to 10 s after the API sets the session to 'starting'.
  healthCheckIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
  budgets: appConfig.agentRuntime.defaultBudgets,
  agentRiskDefaults: appConfig.agentRiskDefaults as unknown as Record<string, unknown>,
  streamSubscribe: async (agentId: string) => agentStreamSubscribeFn?.(agentId),
  onAgentStatusChange: (agentId, userId, status) => {
    userEventPublisher.publishAgentStatus(userId, agentId, status as 'starting' | 'active' | 'stopped' | 'crashed').catch((err) => {
      logger.error({ err, agentId }, 'Failed to publish agent status event');
    });
  },
  onSessionActive: (agentId, executionMode, sessionId) => {
    const mode = (executionMode === 'shadow' || executionMode === 'live') ? executionMode : 'paper';
    // Track the session that initiated this actor so stop can correlate
    agentState.markSessionPending(agentId, sessionId);
    return (async (): Promise<boolean> => {
      const binding = await agentIntakeResolver.resolveBinding(agentId);
      if (!agentState.isCurrentFallbackSession(agentId, sessionId)) {
        logger.info({ agentId, sessionId }, 'Agent trading actor start abandoned — session changed during binding resolution');
        return false;
      }
      if (!binding) {
        logger.debug({ agentId }, 'No active binding for agent — grant fallback remains disabled');
        agentState.clearPending(agentId, sessionId);
        return false;
      }

      try {
        // Determine venue type from venue name heuristic
        const venueType: 'orderbook' | 'swap' = (binding.venue === 'jupiter' || binding.venue === '1inch') ? 'swap' : 'orderbook';
        const agent = await agentRepo.getAgent(agentId);
        const capitalStr = agent?.capital ?? null;
        const agentDefaults = appConfig.agentRiskDefaults;

        // Resolve swap asset metadata from binding for non-paper swap modes.
        // Agents can proceed without swapAssets — decimals are resolved at decision time.
        // Bots are validated at startup by BotConfigSchema (swapAssets required for swap venues).
        let resolvedSwapAssets: { baseAsset: string; quoteAsset: string; baseDecimals: number; quoteDecimals: number } | undefined;
        if (venueType === 'swap') {
          resolvedSwapAssets = resolveSwapAssetsFromBinding(binding);
        }

        let actor: AgentTradingActor | undefined;

        // Guard: reject unsupported 1inch chain before actor starts (mirrors bot path)
        const resolvedSwapNetwork = resolveSwapNetwork(binding.venue, binding, appConfig.venues['1inch']);
        if (venueType === 'swap' && binding.venue === '1inch' && appConfig.marketData?.tokenSafety?.enabled && !resolvedSwapNetwork) {
          throw new CredentialResolutionError(
            `Unsupported 1inch chain for agent ${agentId} — no token-safety network resolved from binding or config`,
          );
        }

        actor = new AgentTradingActor({
          agentId,
          executionMode: mode,
          venueAccountId: binding.venueAccountId,
          venue: binding.venue,
          venueType,
          riskLimits: buildAgentRiskLimits({
            capital: agent?.capital ?? null,
            dailyLossLimit: agent?.dailyLossLimit ?? null,
            maxOpenPositions: agent?.maxOpenPositions ?? null,
            maxPositionSizePct: agent?.maxPositionSizePct ?? null,
            stopLossPct: agent?.stopLossPct ?? null,
            stopLossCooldownMs: agent?.stopLossCooldownMs ?? null,
          }, agentDefaults, (agent?.riskOverrides as Record<string, number> | null) ?? {}),
          venueAdapterFactory,
          createStreamPoolHandle: venueType !== 'swap'
            ? (testnet: boolean) => createScopedStreamPoolHandle(publicStreamPool, binding.venue, testnet)
            : undefined,
          markSource: oracleMarkSource,
          journal,
          idGen,
          positionRepo,
          fillRepo,
          planRepo,
          orderRepo,
          decisionRepo,
          balanceSnapshotRepo,
          backtestingRepo,
          reconciliationRepo,
          reconciliationConfig,
          streamConfig: appConfig.streams.private,
          liveRollout: appConfig.liveRollout,
          driftAlertOnly: appConfig.reconciliation.driftAlertOnly,
          swapNetwork: resolvedSwapNetwork,
          swapBaseTokenAddress: resolvedSwapAssets?.baseAsset,
          swapAssets: resolvedSwapAssets,
          swapTokenSafety: venueType === 'swap' ? swapTokenSafety : undefined,
          ...(capitalStr != null ? { capital: capitalStr } : {}),
          feeConfig: appConfig.simulation,
          maxConsecutiveVenueErrors: appConfig.liveRollout.maxConsecutiveVenueErrors,
          slippageAlertBps: appConfig.liveRollout.slippageAlertBps,
          crashPolicy: appConfig.liveRollout.crashPolicy,
          liveOrderTimeoutPolicy: {
            limitOrderTimeoutMs: appConfig.liveRollout.limitOrderTimeoutMs,
            marketOrderTimeoutMs: appConfig.liveRollout.marketOrderTimeoutMs,
            checkIntervalMs: appConfig.liveRollout.timeoutCheckIntervalMs,
          },
          onCrashed: async (err) => {
            agentState.deregisterOnCrash(agentId, sessionId, actor!);
            await sessionManager.handleRuntimeFailure(sessionId, agentId, agent?.userId, err);
          },
          onTechnicalScanComplete: (scanAgentId, scan) => {
            eventPublisher.emitTechnicalScanCompleted(scanAgentId, scan).catch((err: unknown) => {
              logger.warn({ err, agentId: scanAgentId }, 'Failed to emit technical scan completed');
            });
          },
          emitAgentWake: (wakeAgentId, payload) => eventPublisher.emitAgentWake(wakeAgentId, payload),
          hasIntelligenceConfig: !!agent?.unifiedConfig?.intelligence,
        });

        await actor.start();

        // Only register if the session is still active (not stopped during start)
        if (agentState.isSessionPending(agentId, sessionId)) {
          agentState.registerActor(agentId, sessionId, actor, mode, venueType);
          instanceExecutionModes.set(agentId, mode);
          logger.info({ agentId, mode, venue: binding.venue }, 'Agent trading actor registered');
          void actorHealthPublisher.publish({
            actorType: 'agent',
            actorId: agentId,
            status: 'healthy',
            reasons: [],
            executionMode: mode,
            updatedAt: new Date().toISOString(),
            streamState: venueType === 'orderbook' ? 'connected' : 'not_applicable',
            reconciliationState: 'healthy',
          });
          return true;
        } else {
          // Session changed while starting — tear down immediately
          await actor.stop();
          logger.info({ agentId, sessionId }, 'Agent trading actor discarded — session changed during start');
          return false;
        }
      } finally {
        agentState.clearPending(agentId, sessionId);
      }
    })();
  },
  onSessionStopped: (agentId, sessionId) => {
    const actor = agentState.handleSessionStopped(agentId, sessionId);
    if (actor && actor instanceof AgentTradingActor) {
      actor.stop().catch((err) => logger.error({ err, agentId }, 'Failed to stop agent trading actor'));
    }
    void actorHealthPublisher.publish({
      actorType: 'agent',
      actorId: agentId,
      status: 'stopped',
      reasons: ['session_stopped'],
      executionMode: instanceExecutionModes.get(agentId) ?? 'paper',
      updatedAt: new Date().toISOString(),
    });
    instanceExecutionModes.delete(agentId);
  },
  onSessionStarted: (agentId, sessionId) => sendSessionStartedTelegramAnchor(agentId, sessionId),
  usageBillingRepo: new UsageBillingRepository(db, appConfig.usageBilling.defaultRateCardItems, providersYaml),
  plansConfig: appConfig.plans,
  usageBillingConfig: appConfig.usageBilling,
  providersYaml,
}, agentReconnectHandler, platformAlerts);

// Queue used by the broker callback to enqueue bot start jobs
const lifecycleQueue = new Queue(QUEUE_NAME, { connection: redisConnection });

const botRepo = new BotRepository(db);
const botStartCallback = async (botId: string, userId: string, tradingBindingId: string, config: Record<string, unknown>) => {
  await lifecycleQueue.add('start-instance', {
    command: 'start',
    botId,
    config: { ...config, tradingBindingId, userId },
  });
};
const botStopCallback = async (botId: string) => {
  await lifecycleQueue.add('stop-instance', {
    command: 'stop',
    botId,
  });
};
const botRestartCallback = async (botId: string, userId: string, tradingBindingId: string, config: Record<string, unknown>) => {
  await lifecycleQueue.add('restart-instance', {
    command: 'restart',
    botId,
    config: { ...config, tradingBindingId, userId },
  });
};

// Enforce the subscription-level bot cap when an agent tries to create a bot.
// Uses the user's actual planId so free-tier users can't create unlimited bots via agents.
const botLimitCheckCallback = async (userId: string): Promise<void> => {
  if (!appConfig.plans) return;
  const userRows = await db.select({ planId: users.planId, isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).limit(1);
  if (userRows[0]?.isAdmin) {
    return;
  }
  const planId = userRows[0]?.planId ?? appConfig.plans.defaultPlanId;
  const plan = appConfig.plans.plans[planId] ?? appConfig.plans.plans[appConfig.plans.defaultPlanId];
  if (!plan) return;
  const maxBots = plan.entitlements.limits.maxBots;
  const botRows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
  if (botRows.length >= maxBots) {
    throw new Error(`Bot limit reached (${maxBots} on your plan). Stop or delete a bot before creating a new one.`);
  }
};

// Enforce plan-level live execution eligibility when an agent creates a live-mode bot.
// Mirrors the API-level checkLiveEnabled gate that the agent broker path previously bypassed.
const botLiveCheckCallback = async (userId: string): Promise<void> => {
  if (!appConfig.plans) return;
  const userRows = await db.select({ planId: users.planId, isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).limit(1);
  if (userRows[0]?.isAdmin) {
    return;
  }
  const planId = userRows[0]?.planId ?? appConfig.plans.defaultPlanId;
  const plan = appConfig.plans.plans[planId] ?? appConfig.plans.plans[appConfig.plans.defaultPlanId];
  if (!plan?.entitlements?.limits?.liveEnabled) {
    throw new Error(
      'Live execution mode is not available on your plan. Upgrade to a plan that supports live trading.',
    );
  }
};

const agentBroker = new AgentMessageBroker(
  redisClient,
  agentRepo,
  agentDecisionHandler,
  sessionManager,
  eventPublisher,
  workerTelegram,
  botRepo,
  botStartCallback,
  botLimitCheckCallback,
  botLiveCheckCallback,
  botStopCallback,
  botRestartCallback,
  workerEmail,
  (agentId, config) => {
    const actor = actorRegistry.get(agentId);
    if (actor instanceof AgentTradingActor && actor.isRunning) {
      actor.applyPendingConfigUpdate(config as Parameters<typeof actor.applyPendingConfigUpdate>[0]);
    }
  },
);
const agentStreamConsumer = new AgentStreamConsumer(redisClient, agentBroker);
agentStreamSubscribeFn = (agentId: string) => agentStreamConsumer.subscribe(agentId);
const agentHealthMonitor = new AgentHealthMonitor(db, sessionManager, undefined, agentRuntimeLauncher);

const reminderCoordinator = new ReminderCoordinator(redisClient, agentRepo, eventPublisher);

// Strategy factory keyed by config.strategy.type (trading style) and config.strategy.decisionMode (engine)
function createStrategy(strategyConfig: StrategyConfig, candleFetcher?: CandleFetcher): Strategy {
  // DCA is timer-driven, no signal evaluation — route to DCA executor
  if (strategyConfig.type === 'dca') {
    return new DcaStrategy();
  }

  // For non-DCA, key on decisionMode to select the engine
  switch (strategyConfig.decisionMode) {
    case 'mechanical': {
      if (!candleFetcher) {
        throw new Error(`'mechanical' strategy requires marketData to be configured (CandleFetcher unavailable)`);
      }
      return new MechanicalStrategy(candleFetcher, null, () => idGen.decisionId());
    }

    case 'llm':
      return new LlmStrategy(
        () => idGen.decisionId(),
        async (artifact) => { await backtestingRepo.insertLlmArtifact({ ...artifact, parsedDecision: artifact.parsedDecision as Record<string, unknown> | null }); },
      );

    case 'hybrid': {
      if (!candleFetcher) throw new Error(`'hybrid' strategy requires marketData to be configured (CandleFetcher unavailable)`);
      const mechanical = new MechanicalStrategy(candleFetcher, null, () => idGen.decisionId());
      const llm = new LlmStrategy(
        () => idGen.decisionId(),
        async (artifact) => { await backtestingRepo.insertLlmArtifact({ ...artifact, parsedDecision: artifact.parsedDecision as Record<string, unknown> | null }); },
      );
      return new HybridStrategy(mechanical, llm);
    }

    default:
      throw new Error(`Unsupported decisionMode: ${strategyConfig.decisionMode}`);
  }
}

// Reconciliation config sourced from operator config
const reconciliationConfig = appConfig.reconciliation;

// Worker-scoped public stream pool — one WebSocket per venue, fan-out to all actors.
// Initialised when at least one orderbook venue has a wsUrl configured.
const publicStreamConfig = appConfig.streams.public;

const streamConnectors = buildPublicStreamConnectors(appConfig.venues);

const publicStreamPool = streamConnectors.size > 0
  ? new PublicStreamPool(publicStreamConfig, streamConnectors)
  : undefined;

// Shared venue adapter factory — used by both bot startup and agent trading actors
const venueAdapterFactory = new VenueAdapterFactory({
  db,
  journal,
  venues: appConfig.venues,
  streamConfig: appConfig.streams.private,
});

const runtime = new WorkerRuntime(
  {
    redis: redisConnection,
    scanIntervalMs: appConfig.worker.scanIntervalMs,
    concurrency: appConfig.worker.concurrency,
    onStartFailed: async (botId, error) => {
      logger.error(
        {
          botId,
          err: error.message,
          ...(error instanceof LiveGateError && { code: error.code }),
        },
        'Instance start failed — marking crashed'
      );
      await db.update(bots)
        .set({ status: 'crashed', stoppedAt: new Date(), updatedAt: new Date() })
        .where(eq(bots.id, botId));
      // Publish real-time crash event (best-effort)
      try {
        const userId = instanceUserIds.get(botId)
          ?? (await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, botId)).limit(1))[0]?.userId;
        if (userId) {
          await userEventPublisher.publishBotStatus(userId, botId, 'crashed');
        }
      } catch { /* best-effort */ }
      void actorHealthPublisher.publish({
        actorType: 'bot',
        actorId: botId,
        status: 'crashed',
        reasons: ['start_failed', error.message],
        executionMode: instanceExecutionModes.get(botId) ?? 'paper',
        updatedAt: new Date().toISOString(),
      });
      instanceUserIds.delete(botId);
      instanceExecutionModes.delete(botId);
    },
    onStopped: async (instanceId: string) => {
      // Persist stopped state to DB so bots stopped via BullMQ or worker
      // shutdown are consistent with in-memory state. Don't let a DB failure
      // block in-memory cleanup (plan risk mitigation).
      try {
        await botRepo.markBotStopped(instanceId);
      } catch (err) {
        logger.error({ err, instanceId }, 'Failed to persist stopped state to DB');
      }

      actorRegistry.delete(instanceId);
      agentStreamConsumer.unsubscribe(instanceId);
      // Sessions are agent-scoped, not instance-scoped; stop session via agentRepo.getActiveSession if needed
      // Publish real-time stopped event (best-effort)
      try {
        const userId = instanceUserIds.get(instanceId)
          ?? (await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, instanceId)).limit(1))[0]?.userId;
        if (userId) {
          await userEventPublisher.publishBotStatus(userId, instanceId, 'stopped');
        }
      } catch { /* best-effort */ }
      void actorHealthPublisher.publish({
        actorType: 'bot',
        actorId: instanceId,
        status: 'stopped',
        reasons: ['stopped'],
        executionMode: instanceExecutionModes.get(instanceId) ?? 'paper',
        updatedAt: new Date().toISOString(),
      });
      instanceUserIds.delete(instanceId);
      instanceExecutionModes.delete(instanceId);
    },
    onStarted: (botId) => {
      // Publish running event after actor.start() has completed successfully.
      // instanceUserId was stored by the factory into instanceUserIds.
      const userId = instanceUserIds.get(botId);
      if (userId) {
        userEventPublisher.publishBotStatus(userId, botId, 'running').catch((err) => {
          logger.error({ err, botId }, 'Failed to publish bot running event');
        });
      }
      void actorHealthPublisher.publish({
        actorType: 'bot',
        actorId: botId,
        status: 'healthy',
        reasons: [],
        executionMode: instanceExecutionModes.get(botId) ?? 'paper',
        updatedAt: new Date().toISOString(),
      });
    },
  },
  async (botId, rawConfig) => {
    // Validate instance config — fail fast on invalid config
    const parseResult = BotConfigSchema.safeParse(rawConfig);
    if (!parseResult.success) {
      throw new Error(
        `Invalid config for bot ${botId}: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const config = parseResult.data;
    // venue and venueType are stamped by the broker before persistence — always
    // present at runtime for any bot that reaches this reclaim path.
    const venue = config.venue!;
    const venueType = config.venueType!;

    const startupContext = await resolveBotStartupContext({
      db,
      botRepo,
      botId,
      rawConfig,
      venue,
      venueType,
    });

    const venueAccountId = startupContext.sourceVenueAccountId;
    // The resolver already validated the source-venue-account requirement per provider type.
    // Consume the resolver's decision here rather than re-encoding provider-specific logic.
    if (startupContext.sourceVenueAccountRequired && !venueAccountId) {
      throw new BotStartupError('missing_source_venue_account', `Bot ${botId} has no resolved source venue account — refusing to start`);
    }
    // Narrow for downstream: orderbook venues fail the throw above, supported swap
    // venues (1inch, Jupiter) also fail it, unsupported swap venues throw separately.
    const resolvedVenueAccountId: string = venueAccountId!;
    const instanceUserId = startupContext.userId ?? (rawConfig['userId'] as string | undefined);
    let testnet = false;
    let resolvedCredentialId: string | undefined;
    let credentialsPresent = false;
    let signerPresent = false;
    let venueAdapter: OrderbookVenuePort | undefined;
    let swapVenue: SwapVenuePort | undefined;
    let swapConfirmationPoller: import('@herobids/venues').SwapConfirmationPoller | undefined;

    // Resolve adapters via shared factory
    if (venueType !== 'swap') {
      const result = await venueAdapterFactory.buildOrderbookAdapter({
        venueAccountId: resolvedVenueAccountId,
        venue,
        actorType: 'bot',
        actorId: botId,
        executionMode: config.execution.mode,
      });
      venueAdapter = result.venuePort;
      testnet = result.credentials.testnet;
      resolvedCredentialId = result.credentialId;
      credentialsPresent = !!(result.credentials.apiKey.trim() && result.credentials.secret.trim());
    } else if (config.swapAssets) {
      const result = await venueAdapterFactory.buildSwapAdapter({
        venueAccountId: resolvedVenueAccountId,
        venue,
        swapAssets: config.swapAssets,
        actorType: 'bot',
        actorId: botId,
      });
      swapVenue = result.swapVenue;
      signerPresent = result.signerPresent;
      swapConfirmationPoller = result.confirmationPoller;
    } else {
      throw new CredentialResolutionError(
        `swapAssets config required for swap venue bot ${botId} — cannot route swaps without explicit asset identifiers and decimals`,
      );
    }

    // --- Live-mode startup gate (fail-closed) ---
    const liveGateResult = assertLiveReadiness(appConfig.liveRollout, {
      executionMode: config.execution.mode,
      venue,
      venueType,
      venueAccountId: resolvedVenueAccountId,
      credentialsFromDb: !!resolvedCredentialId,
      credentialsPresent,
      signerPresent,
      driftAlertOnly: appConfig.reconciliation.driftAlertOnly,
      instanceMaxOrderNotional: config.risk.maxOrderNotional,
    });

    // Stream config (shared between adapter construction and actor deps)
    const streamConfig = appConfig.streams.private;

    const fetchPrice = async (): Promise<MarketSnapshot | null> => {
      if (!venueAdapter) return null; // Swap venues don't use orderbook ticker
      const result = await venueAdapter.fetchTicker(config.symbol);
      if (!result.ok) {
        logger.warn({ botId, symbol: config.symbol, error: result.error }, 'fetchTicker failed');
        return null;
      }
      return {
        symbol: config.symbol,
        price: result.data.last,
        timestamp: result.data.timestamp,
      };
    };

    let recordMarketSnapshot: TradingActorDeps['recordMarketSnapshot'];
    let recordReferenceMark: TradingActorDeps['recordReferenceMark'];

    if (appConfig.marketDataRecording.enabled) {
      const recorder = new MarketDataRecorder(venue);
      const corpusId = await backtestingRepo.insertCorpus({
        name: `${botId}-${new Date().toISOString()}`,
        source: 'live-recording',
        venue,
        symbols: [config.symbol],
        userId: instanceUserId,
        metadata: {
          botId,
            tradingBindingId: startupContext.tradingBindingId,
          venueAccountId,
          captureTrades: appConfig.marketDataRecording.captureTrades,
          captureTopOfBook: appConfig.marketDataRecording.captureTopOfBook,
          captureCandles: appConfig.marketDataRecording.captureCandles,
        },
      });

      let corpusStartAt: Date | undefined;
      let corpusEndAt: Date | undefined;

      const flushRecordedEvents = async (): Promise<void> => {
        const events = recorder.flush();
        if (events.length === 0) return;

        await backtestingRepo.insertMarketEventsBatch(events.map((event) => ({
          corpusId,
          venue: event.venue,
          symbol: event.symbol,
          eventType: event.eventType,
          price: event.price,
          eventAt: event.eventAt,
          data: event.data,
        })));

        const batchStart = events[0]!.eventAt;
        const batchEnd = events[events.length - 1]!.eventAt;
        corpusStartAt = corpusStartAt && corpusStartAt < batchStart ? corpusStartAt : batchStart;
        corpusEndAt = corpusEndAt && corpusEndAt > batchEnd ? corpusEndAt : batchEnd;
        await backtestingRepo.updateCorpusWindow(corpusId, corpusStartAt, corpusEndAt);
      };

      recordMarketSnapshot = async (snapshot) => {
        if (!appConfig.marketDataRecording.captureTopOfBook) return;
        recorder.recordSnapshot(snapshot);
        await flushRecordedEvents();
      };

      recordReferenceMark = async (mark) => {
        recorder.recordMark(mark.symbol, mark.price, mark.source, mark.timestamp);
        await flushRecordedEvents();
      };
    }

    const swapNetwork = resolveSwapNetwork(venue, undefined, appConfig.venues['1inch']);

    if (venueType === 'swap' && venue === '1inch' && appConfig.marketData?.tokenSafety?.enabled && !swapNetwork) {
      throw new CredentialResolutionError(
        `Unsupported 1inch chainId ${String(appConfig.venues['1inch']?.chainId)} for token safety on bot ${botId}`,
      );
    }

    const candleFetcher: CandleFetcher | undefined = sharedMarketDataRegistry
      ? new VenueCandleFetcher(
          sharedMarketDataRegistry.configs.binance,
          swapNetwork != null
            ? { config: sharedMarketDataRegistry.configs.geckoterminal, network: swapNetwork }
            : null,
          venueType === 'swap' ? 'swap' : 'orderbook',
        )
      : undefined;

    const strategy = createStrategy(config.strategy, candleFetcher);

    const deps: TradingActorDeps = {
      strategy,
      journal,
      fillRepo,
      positionRepo,
      planRepo,
      orderRepo,
      decisionRepo,
      backtestingRepo,
      balanceSnapshotRepo,
      reconciliationRepo,
      riskLimits: {
        maxPositionSize: quantity(String(config.risk.maxPositionSize ?? '100')),
        maxOpenPositions: config.risk.maxOpenPositions ?? 5,
        maxDrawdown: price(String(config.risk.maxDrawdown ?? '10000')),
        maxPositionSizePct: config.risk.maxPositionSizePct,
        dailyMaxLossPct: config.risk.dailyMaxLossPct,
        stopLossCooldownMs: config.risk.stopLossCooldownMs,
        stopLossMaxUnrealizedLossPct: config.risk.stopLossMaxUnrealizedLossPct,
        maxOrderNotional: liveGateResult.effectiveMaxOrderNotional,
      },
      idGen,
      fetchPrice,
      venuePort: config.execution.mode === 'paper' ? undefined : (venueAdapter ?? undefined),
      reconciliationConfig,
      executionMode: config.execution.mode,
      streamConfig,
      venue,
      symbol: config.symbol,
      venueAccountId: resolvedVenueAccountId,
      venueType,
      swapAssets: config.swapAssets,
      swapNetwork,
      swapBaseTokenAddress: venueType === 'swap' ? config.swapAssets?.baseAsset : undefined,
      swapVenue,
      streamPool: venueType !== 'swap'
        ? createScopedStreamPoolHandle(publicStreamPool, venue, testnet)
        : undefined,
      markSource: new MarkSelector(
        { stalenessThresholdMs: appConfig.marking.stalenessThresholdMs },
        new LastFillMarkSource(fillRepo, botId),
        oracleMarkSource,
      ),
      recordMarketSnapshot,
      recordReferenceMark,
      shadowPollIntervalMs: config.shadowPollIntervalMs ?? appConfig.execution.shadowPollIntervalMs,
      shadowQuoteSlippageBps: appConfig.execution.shadowQuoteSlippageBps,
      credentialId: resolvedCredentialId,
      swapTokenSafety: config.venueType === 'swap' ? swapTokenSafety : undefined,
      swapTokenSafetyThresholds: (config.risk.minSwapTokenLiquidityUsd != null || config.risk.minSwapTokenVolume24hUsd != null || config.risk.minSwapTokenAgeHours != null || config.risk.allowSwapTokenSafetyOverride != null)
        ? {
            minLiquidityUsd: config.risk.minSwapTokenLiquidityUsd,
            minVolume24hUsd: config.risk.minSwapTokenVolume24hUsd,
            minAgeHours: config.risk.minSwapTokenAgeHours,
            allowOverrides: config.risk.allowSwapTokenSafetyOverride,
          }
        : undefined,
      feeConfig: appConfig.simulation,
      maxConsecutiveVenueErrors: appConfig.liveRollout.maxConsecutiveVenueErrors,
      slippageAlertBps: appConfig.liveRollout.slippageAlertBps,
      crashPolicy: appConfig.liveRollout.crashPolicy,
      liveOrderTimeoutPolicy: {
        limitOrderTimeoutMs: appConfig.liveRollout.limitOrderTimeoutMs,
        marketOrderTimeoutMs: appConfig.liveRollout.marketOrderTimeoutMs,
      },
      swapConfirmationPoller,
      candleFetcher,
      riskPlaybook: (config.risk.maxNewPositionsPerDay != null || config.risk.avoidParabolicMovePct != null)
        ? {
            maxNewPositionsPerDay: config.risk.maxNewPositionsPerDay,
            avoidParabolicMovePct: config.risk.avoidParabolicMovePct,
          }
        : undefined,
      onCrashed: async (instanceId: string) => {
          actorRegistry.delete(instanceId);
          agentStreamConsumer.unsubscribe(instanceId);
          await db.update(bots)
            .set({ status: 'crashed', stoppedAt: new Date() })
            .where(eq(bots.id, instanceId));
          // Remove from runtime map and release lease
          await runtime.handleActorCrash(instanceId);
          logger.error({ botId: instanceId }, 'Bot marked as crashed in DB');
          // Publish real-time status event (best-effort — do not fail the crash handler)
          if (instanceUserId) {
            userEventPublisher.publishBotStatus(instanceUserId, instanceId, 'crashed').catch((err) => {
              logger.error({ err, botId: instanceId }, 'Failed to publish bot crash event');
            });
          }
          void actorHealthPublisher.publish({
            actorType: 'bot',
            actorId: instanceId,
            status: 'crashed',
            reasons: ['runtime_crash'],
            executionMode: instanceExecutionModes.get(instanceId) ?? 'paper',
            updatedAt: new Date().toISOString(),
          });
          instanceExecutionModes.delete(instanceId);
        },
    };
    const actor = new TradingActor(botId, config.strategy.params as Record<string, unknown>, deps);
    actorRegistry.set(botId, actor);
    // Record userId so onStarted / onStartFailed / onStopped callbacks can publish events.
    if (instanceUserId) instanceUserIds.set(botId, instanceUserId);
    instanceExecutionModes.set(botId, config.execution.mode);
    try {
      await agentStreamConsumer.subscribe(botId);
    } catch (err: unknown) {
      actorRegistry.delete(botId);
      instanceUserIds.delete(botId);
      instanceExecutionModes.delete(botId);
      throw err;
    }
    return actor;
  },
  async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(bots).where(eq(bots.status, 'running'));
    return running.map((row) => ({
      id: row.id,
      config: { ...row.config, tradingBindingId: row.tradingBindingId, venueAccountId: row.venueAccountId, userId: row.userId },
    }));
  },
  lease,
);

// Start backtest runtime (BullMQ consumer for bounded backtest jobs)
const backtestRuntime = new BacktestRuntime(
  {
    redis: redisConnection,
    concurrency: appConfig.backtesting.concurrency,
    maxDataGapMs: appConfig.backtesting.maxDataGapMs,
    defaultWarmUpFrames: appConfig.backtesting.warmupLookbackBars,
    validationThresholds: {
      maxDecisionDivergencePct: appConfig.llmValidation.maxDecisionDivergencePct,
      maxPnlRegressionPct: appConfig.llmValidation.maxPnlRegressionPct,
    },
  },
  db,
);
backtestRuntime.start();

// Start alert dispatcher (polls journal → routes → delivers to Telegram)
// Uses Redis lease for singleton coordination across multiple workers
const alertDispatcher = new AlertDispatcher(appConfig.alerts, journal, alertDeliveryRepo, logger, redisClient, workerId);
await alertDispatcher.start();

// Start always-on market intelligence coordinator and monitor.
// Uses Redis-based leader election so only one worker instance runs
// discovery polling and monitor evaluation at a time. The monitor is
// started and stopped by the coordinator as it gains/loses the lease,
// ensuring evaluation never races across multiple worker processes.
const miConfig = appConfig.marketIntelligence;
const marketMonitor = createMarketMonitor(
  {
    enabled: miConfig.enabled && Boolean(appConfig.marketData),
    evaluationIntervalMs: miConfig.evaluationIntervalMs,
    families: {
      watchThresholds: miConfig.families.watchThresholds.enabled,
      discoveryDeltas: miConfig.families.discoveryDeltas.enabled,
      regimeChanges: miConfig.families.regimeChanges.enabled,
    },
    wakeCoalescingWindowMs: miConfig.wakeCoalescingWindowMs,
    wakeCooldownMs: miConfig.wakeCooldownMs,
  },
  { redis: redisClient, publisher: eventPublisher },
);

const marketIntelCoordinator = appConfig.marketData
  ? (() => {
      const coordinator = createMarketDataCoordinator(
        {
          workerId,
          networks: miConfig.networks,
          benchmarkSymbols: miConfig.benchmarkSymbols,
          discoveryPollMs: miConfig.discoveryPollMs,
          regimePollMs: miConfig.regimePollMs,
          enabled: miConfig.enabled,
          discoveryMaxResults: appConfig.marketData.discovery.maxResults,
        },
        { redis: redisClient, providerRegistry: sharedMarketDataRegistry!, publisher: eventPublisher, monitor: marketMonitor },
      );
      return coordinator;
    })()
  : undefined;

marketIntelCoordinator?.start();

// ── LLM Pricing Refresh ─────────────────────────────────────────────────────

/** Resolve the API key for a given LLM provider from environment variables. */
function resolveLlmApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

/**
 * Seed static provider pricing from config/providers.yaml into the DB.
 * Only inserts if no active snapshot exists for the provider (idempotent).
 */
async function seedStaticPricing(
  providers: ProvidersYaml,
  repo: UsageBillingRepository,
): Promise<void> {
  for (const [providerId, config] of Object.entries(providers.providers)) {
    if (config.catalogMode !== 'static') continue;

    const existing = await repo.getLatestPricingSnapshot(providerId);
    if (existing) continue; // already seeded from prior deploy

    const models: Record<string, { inputUsdPerM: number; outputUsdPerM: number; reasoningUsdPerM?: number }> = {};
    for (const [modelId, m] of Object.entries(config.models)) {
      if (m.inputUsdPerM == null || m.outputUsdPerM == null) continue;
      models[modelId] = {
        inputUsdPerM: m.inputUsdPerM,
        outputUsdPerM: m.outputUsdPerM,
        ...(m.reasoningUsdPerM != null ? { reasoningUsdPerM: m.reasoningUsdPerM } : {}),
      };
    }

    if (Object.keys(models).length === 0) continue;

    await repo.upsertPricingSnapshot({
      id: `seed_${providerId}_v1`,
      provider: providerId,
      fetchedAt: null, // static — no fetch timestamp
      models,
    });

    logger.info({ provider: providerId, modelCount: Object.keys(models).length },
      'Seeded static pricing snapshot from config');
  }
}

/**
 * Refresh dynamic provider pricing from their APIs and persist to DB.
 * On failure, logs a warning and keeps the existing snapshot.
 */
async function refreshDynamicPricing(
  providers: ProvidersYaml,
  repo: UsageBillingRepository,
): Promise<void> {
  for (const [providerId, config] of Object.entries(providers.providers)) {
    if (config.catalogMode !== 'dynamic' || !config.fetchUrl) continue;

    try {
      const apiKey = resolveLlmApiKey(providerId);
      if (!apiKey) {
        logger.warn({ provider: providerId }, 'No API key configured — skipping dynamic pricing refresh');
        continue;
      }

      const result = await fetchOpenRouterPricing({
        apiKey,
        fetchUrl: config.fetchUrl,
        timeoutMs: 15_000,
      });

      if (Object.keys(result.models).length === 0) {
        logger.warn({ provider: providerId }, 'Dynamic pricing fetch returned empty — keeping existing snapshot');
        continue;
      }

      const now = new Date();
      await repo.upsertPricingSnapshot({
        id: `${providerId}_${now.toISOString()}`,
        provider: providerId,
        fetchedAt: now,
        models: result.models,
      });

      logger.info({ provider: providerId, modelCount: Object.keys(result.models).length },
        'Dynamic pricing snapshot refreshed');
    } catch (err) {
      logger.warn({ err, provider: providerId }, 'Failed to refresh dynamic pricing — will retry next tick');
    }
  }
}

// Periodic health refresh: re-publish healthy snapshots for all registered actors
// so Redis entries do not expire while actors are running. Refresh at half the TTL.
const HEALTH_REFRESH_INTERVAL_MS = (ACTOR_HEALTH_TTL_SECONDS / 2) * 1000;
const healthRefreshInterval = setInterval(() => {
  const now = new Date().toISOString();
  for (const [id] of actorRegistry) {
    const isAgent = agentState.getActor(id) !== undefined;
    void actorHealthPublisher.publish({
      actorType: isAgent ? 'agent' : 'bot',
      actorId: id,
      status: 'healthy',
      reasons: [],
      executionMode: instanceExecutionModes.get(id) ?? 'paper',
      updatedAt: now,
    });
  }
}, HEALTH_REFRESH_INTERVAL_MS);

// ── LLM Pricing — seed static + refresh dynamic on startup ──────────────────
const pricingRepo = new UsageBillingRepository(db);

// Seed on startup (idempotent)
seedStaticPricing(providersYaml, pricingRepo).catch((err) => {
  logger.error({ err }, 'Failed to seed static LLM pricing on startup');
});

// Refresh dynamic pricing immediately on startup
refreshDynamicPricing(providersYaml, pricingRepo).catch((err) => {
  logger.error({ err }, 'Failed to refresh dynamic LLM pricing on startup');
});

// Periodic refresh: use catalogCacheTtlMs from operator config (default ~24h per default.yaml)
const PRICING_REFRESH_INTERVAL_MS = appConfig.llm.catalog.cacheTtlMs;
const pricingRefreshInterval = setInterval(() => {
  refreshDynamicPricing(providersYaml, pricingRepo).catch((err) => {
    logger.error({ err }, 'Failed to refresh dynamic LLM pricing on tick');
  });
}, PRICING_REFRESH_INTERVAL_MS);

// Register graceful shutdown handlers after all services are fully initialized.
// Placing them here guarantees no temporal-dead-zone reference errors if a
// signal arrives during the async startup above.
//
// ## Agent container lifetime on shutdown
// sessionManager.stop() stops the reconciliation loop only — it does NOT kill
// agent containers. Containers are designed to outlive the worker process so that
// a routine redeploy or crash does not interrupt live agents. The next worker
// instance picks them up via the heartbeat recovery path in AgentSessionManager.
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  clearInterval(healthRefreshInterval);
  clearInterval(pricingRefreshInterval);
  agentRuntimeLauncher.stopEventStream();
  agentHealthMonitor.stop();
  agentStreamConsumer.stop();
  reminderCoordinator.stop();
  marketMonitor.stop();
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher.stop();
  await backtestRuntime.stop();
  await runtime.shutdown();
  await publicStreamPool?.shutdown();
  await lifecycleQueue.close();
  await botStopSubscriber?.quit();
  await agentCleanupSubscriber?.quit();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  clearInterval(healthRefreshInterval);
  clearInterval(pricingRefreshInterval);
  agentRuntimeLauncher.stopEventStream();
  agentHealthMonitor.stop();
  agentStreamConsumer.stop();
  reminderCoordinator.stop();
  marketMonitor.stop();
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher.stop();
  await backtestRuntime.stop();
  await runtime.shutdown();
  await publicStreamPool?.shutdown();
  await lifecycleQueue.close();
  await botStopSubscriber?.quit();
  await agentCleanupSubscriber?.quit();
  await redisClient.quit();
  process.exit(0);
});

await agentStreamConsumer.start();
// Start Docker event stream for crash detection (no-op in stub mode)
await agentRuntimeLauncher.startEventStream();

await runtime.start();

// Subscribe to agent-originated bot stop signals (bot:stop:{botId}).
// The agent container publishes this via Redis PUBLISH when the LLM calls stop_bot
// directly. This causes an immediate in-process stop without waiting for a BullMQ job.
botStopSubscriber = new Redis(redisConnection);
botStopSubscriber.psubscribe('bot:stop:*', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to bot:stop:* channels');
});
botStopSubscriber.on('pmessage', (_pattern: string, channel: string, _message: string) => {
  const botId = channel.replace('bot:stop:', '');
  if (!botId) return;
  logger.info({ botId }, 'Received bot:stop signal — stopping instance directly');
  runtime.stopInstanceDirect(botId).catch((err: unknown) => {
    logger.error({ err, botId }, 'Failed to stop instance via bot:stop signal');
  });
});

// Subscribe to API-originated agent cleanup signals (agent:cleanup:{agentId}).
// The API publishes to this channel after DELETE /agents/:id so the worker can
// stop and remove the Docker container that still has no corresponding DB row.
//
// Uses a separate Redis connection (not the main redisClient) to avoid
// interfering with BullMQ's internal connection management.
const agentCleanupInFlight = new Set<string>();
agentCleanupSubscriber = new Redis(redisConnection);
agentCleanupSubscriber.psubscribe('agent:cleanup:*', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to agent:cleanup:* channels');
});
agentCleanupSubscriber.on('pmessage', (_pattern: string, channel: string, _message: string) => {
  const agentId = channel.replace('agent:cleanup:', '');
  if (!agentId) return;
  // Debounce duplicate cleanup signals within 1s (Redis pub/sub has no delivery guarantees).
  if (agentCleanupInFlight.has(agentId)) return;
  agentCleanupInFlight.add(agentId);
  setTimeout(() => agentCleanupInFlight.delete(agentId), 1_000);
  logger.info({ agentId }, 'Received agent:cleanup signal — stopping container');
  agentRuntimeLauncher.stopByAgentId(agentId).catch((err: unknown) => {
    logger.error({ err, agentId }, 'Failed to stop agent container via cleanup signal');
  });
});

sessionManager.start();
agentHealthMonitor.start();
reminderCoordinator.start();
logger.info({ workerId, queue: QUEUE_NAME }, 'Worker process started');
