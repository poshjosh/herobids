import pino from 'pino';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { WorkerRuntime, QUEUE_NAME } from './runtime.js';
import type { PersistedInstance } from './runtime.js';
import { BacktestRuntime } from './backtest-runtime.js';
import { InstanceLease } from './instance-lease.js';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { createSwapTokenSafetyAdapter } from './token-safety-adapter.js';
import { MomentumStrategy, LlmStrategy } from '@herobids/strategy';
import { MarketDataRecorder } from '@herobids/backtesting';
import { createDatabase, PgJournal, FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, ReconciliationEventRepository, DecisionRepository, BacktestingRepository, AlertDeliveryRepository, AgentRepository, BotRepository, TokenSafetyOverrideRepository, bots, venueAccounts, userCredentials, users } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { HyperliquidAdapter, BybitAdapter, JupiterSwapAdapter, OneInchSwapAdapter, PublicStreamPool, OracleMarkSource } from '@herobids/venues';
import type { IdGenerator } from '@herobids/engine';
import { LastFillMarkSource, MarkSelector, credentialDecryptedEvent } from '@herobids/engine';
import type { DecisionContext } from '@herobids/engine';
import { quantity, price, BotConfigSchema, inferOneInchTokenSafetyNetwork } from '@herobids/domain';
import type { MarketSnapshot, OrderId, FillId, Strategy, StrategyConfig } from '@herobids/domain';
import crypto from 'node:crypto';
import { decryptCredential } from './crypto.js';
import { loadConfig } from './config.js';
import { assertLiveReadiness, LiveGateError } from './live-gate.js';
import { buildPublicStreamConnectors, createScopedStreamPoolHandle } from './public-stream-routing.js';
import { AlertDispatcher } from './alerting/index.js';
import { TelegramClient, PlatformAlertService, ResendEmailClient } from './alerting/index.js';
import {
  AgentMessageBroker,
  AgentDecisionHandler,
  AgentRuntimeLauncher,
  AgentSessionManager,
  AgentStreamConsumer,
  AgentHealthMonitor,
  AgentReconnectHandler,
  InstanceEventPublisher,
} from './agents/index.js';
import type { DecisionIntakeResolver, ContextSnapshotResolver } from './agents/index.js';
import { UserEventPublisher } from './user-event-publisher.js';
import { createMarketDataCoordinator, createMarketMonitor } from './market-intelligence/index.js';
import { createProviderRegistry, type RedisEvalClient } from '@herobids/market-data';
import { ReminderCoordinator } from './reminder-coordinator.js';
import type { ResolvedSwapTokenData } from './token-safety-adapter.js';

async function resolveSwapTokenData(
  registry: ReturnType<typeof createProviderRegistry>,
  network: string,
  tokenAddress: string,
): Promise<ResolvedSwapTokenData | null> {
  const searchResult = await registry.dexscreener.search(tokenAddress);
  // Same token can appear in multiple pools — pick the highest-liquidity match
  // to align with the market-data selection semantics used elsewhere.
  const exactMatch = searchResult.data
    .filter((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === tokenAddress.toLowerCase()
    ))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];

  if (!exactMatch) {
    return null;
  }

  if ((exactMatch as typeof exactMatch & { poolCreatedAt?: string }).poolCreatedAt) {
    return {
      ...exactMatch,
      ageResolution: 'available',
    };
  }

  try {
    const discoveryResult = await registry.discovery.discover({
      networks: [network],
      maxResults: 250,
      minLiquidityUsd: 0,
    });
    const discoveryMatch = discoveryResult.data.find((token) => (
      token.network.toLowerCase() === network.toLowerCase()
      && token.address.toLowerCase() === tokenAddress.toLowerCase()
    ));

    if (!discoveryMatch) {
      return {
        ...exactMatch,
        ageResolution: 'indeterminate',
      };
    }

    return {
      ...exactMatch,
      poolCreatedAt: discoveryMatch.poolCreatedAt ?? (exactMatch as typeof exactMatch & { poolCreatedAt?: string }).poolCreatedAt,
      ageResolution: discoveryMatch.poolCreatedAt ? 'available' : 'missing',
    };
  } catch {
    return {
      ...exactMatch,
      ageResolution: 'indeterminate',
    };
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

const sharedMarketDataRegistry = appConfig.marketData
  ? createProviderRegistry(appConfig.marketData, { redisClient: redisClient as unknown as RedisEvalClient })
  : undefined;

const swapTokenSafety = appConfig.marketData && sharedMarketDataRegistry
  ? createSwapTokenSafetyAdapter({
      marketDataConfig: appConfig.marketData,
      overrideRepo: tokenSafetyOverrideRepo,
      resolveTokenData: (network, tokenAddress) => resolveSwapTokenData(sharedMarketDataRegistry, network, tokenAddress),
    })
  : undefined;

// Agent subsystem — registry + protocol stack. Created before WorkerRuntime so the
// actor factory can subscribe streams and register actors on creation.
const actorRegistry = new Map<string, TradingActor>();
/** Maps botId → userId so the onStarted/onStartFailed callbacks can publish events. */
const instanceUserIds = new Map<string, string>();
const agentRepo = new AgentRepository(db);
const eventPublisher = new InstanceEventPublisher(redisClient);
const userEventPublisher = new UserEventPublisher(redisClient);

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
            scout: appConfig.llm.scout,
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

const intakeResolver: DecisionIntakeResolver = {
  getIntakeDeps: (instanceId: string) => {
    const actor = actorRegistry.get(instanceId);
    return actor?.isRunning ? actor.getIntakeDeps() : undefined;
  },
  getDecisionContext: (instanceId: string): DecisionContext | undefined => {
    const actor = actorRegistry.get(instanceId);
    if (!actor?.isRunning) return undefined;
    const snapshot = actor.getLastSnapshot();
    if (!snapshot) return undefined;
    const pos = actor.currentPosition;
    const lastMark = actor.getLastMarkResult();
    const referenceMark = (lastMark?.ok && !lastMark.data.stale)
      ? { price: lastMark.data.price.toString(), source: lastMark.data.source }
      : { price: snapshot.price.toString(), source: 'snapshot' };
    return {
      snapshot: { symbol: snapshot.symbol, price: snapshot.price.toString(), timestamp: snapshot.timestamp },
      position: pos.side === 'flat' ? null : {
        side: pos.side,
        size: pos.size.toString(),
        entryPrice: pos.entryPrice.toString(),
        realizedPnl: pos.realizedPnl.toString(),
      },
      referenceMark,
      strategyParams: {},
    };
  },
  getPosition: (instanceId: string) => {
    const actor = actorRegistry.get(instanceId);
    return actor?.isRunning ? actor.currentPosition : undefined;
  },
};

const agentDecisionHandler = new AgentDecisionHandler(agentRepo, intakeResolver, eventPublisher);

const snapshotResolver: ContextSnapshotResolver = {
  resolveSnapshot: (instanceId: string) => {
    const actor = actorRegistry.get(instanceId);
    if (!actor?.isRunning) return undefined;
    const snapshot = actor.getLastSnapshot();
    if (!snapshot) return undefined;
    const pos = actor.currentPosition;
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

// Late-bound subscribe callback: set once agentStreamConsumer is constructed below.
// sessionManager.reconcileStartingSessions() only runs after sessionManager.start()
// (line ~749), by which point agentStreamConsumer is fully initialized.
let agentStreamSubscribeFn: ((agentId: string) => Promise<void>) | undefined;

const sessionManager = new AgentSessionManager(agentRepo, eventPublisher, agentRuntimeLauncher, {
  // bug-008: reduced from default 10 000 ms to 2 000 ms so agents start within
  // ~2 s instead of up to 10 s after the API sets the session to 'starting'.
  healthCheckIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
  streamSubscribe: async (agentId: string) => agentStreamSubscribeFn?.(agentId),
  onAgentStatusChange: (agentId, userId, status) => {
    userEventPublisher.publishAgentStatus(userId, agentId, status as 'starting' | 'active' | 'stopped' | 'crashed').catch((err) => {
      logger.error({ err, agentId }, 'Failed to publish agent status event');
    });
  },
}, agentReconnectHandler, platformAlerts);

// Queue used by the broker callback to enqueue bot start jobs
const lifecycleQueue = new Queue(QUEUE_NAME, { connection: redisConnection });

const botRepo = new BotRepository(db);
const botStartCallback = async (botId: string, userId: string, venueAccountId: string, config: Record<string, unknown>) => {
  await lifecycleQueue.add('start-instance', {
    command: 'start',
    botId,
    config: { ...config, venueAccountId, userId },
  });
};
const botStopCallback = async (botId: string) => {
  await lifecycleQueue.add('stop-instance', {
    command: 'stop',
    botId,
  });
};
const botRestartCallback = async (botId: string, userId: string, venueAccountId: string, config: Record<string, unknown>) => {
  await lifecycleQueue.add('restart-instance', {
    command: 'restart',
    botId,
    config: { ...config, venueAccountId, userId },
  });
};

// Enforce the subscription-level bot cap when an agent tries to create a bot.
// Uses the user's actual planId so free-tier users can't create unlimited bots via agents.
const botLimitCheckCallback = async (userId: string): Promise<void> => {
  if (!appConfig.plans) return;
  const userRows = await db.select({ planId: users.planId }).from(users).where(eq(users.id, userId)).limit(1);
  const planId = userRows[0]?.planId ?? appConfig.plans.defaultPlanId;
  const planLimits = appConfig.plans.plans[planId] ?? appConfig.plans.plans[appConfig.plans.defaultPlanId];
  if (!planLimits) return;
  const botRows = await db.select({ id: bots.id }).from(bots).where(eq(bots.userId, userId));
  if (botRows.length >= planLimits.maxTradingInstances) {
    throw new Error(`Bot limit reached (${planLimits.maxTradingInstances} on your plan). Stop or delete a bot before creating a new one.`);
  }
};

const agentBroker = new AgentMessageBroker(redisClient, agentRepo, agentDecisionHandler, sessionManager, eventPublisher, workerTelegram, botRepo, botStartCallback, botLimitCheckCallback, botStopCallback, botRestartCallback, workerEmail, (agentId, userId, status) => {
  userEventPublisher.publishAgentStatus(userId, agentId, status).catch((err) => {
    logger.error({ err, agentId }, 'Failed to publish agent status event');
  });
});
const agentStreamConsumer = new AgentStreamConsumer(redisClient, agentBroker);
agentStreamSubscribeFn = (agentId: string) => agentStreamConsumer.subscribe(agentId);
const agentHealthMonitor = new AgentHealthMonitor(db, sessionManager, undefined, agentRuntimeLauncher);

const reminderCoordinator = new ReminderCoordinator(redisClient, agentRepo, eventPublisher);

// Strategy factory keyed by config.strategy.type
function createStrategy(strategyConfig: StrategyConfig): Strategy {
  switch (strategyConfig.type) {
    case 'momentum':
      return new MomentumStrategy(() => idGen.decisionId());
    case 'llm':
      return new LlmStrategy(
        () => idGen.decisionId(),
        async (artifact) => { await backtestingRepo.insertLlmArtifact({ ...artifact, parsedDecision: artifact.parsedDecision as Record<string, unknown> | null }); },
      );
  }
}

// Reconciliation config sourced from operator config
const reconciliationConfig = appConfig.reconciliation;

// ID generator using UUIDv7 (crypto.randomUUID as fallback)
const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
  orderId: () => crypto.randomUUID() as OrderId,
  fillId: () => crypto.randomUUID() as FillId,
  planId: () => crypto.randomUUID(),
  decisionId: () => crypto.randomUUID(),
};

// Worker-scoped public stream pool — one WebSocket per venue, fan-out to all actors.
// Initialised when at least one orderbook venue has a wsUrl configured.
const publicStreamConfig = appConfig.streams.public;
const bybitVenueConfig = appConfig.venues['bybit'];

const streamConnectors = buildPublicStreamConnectors(appConfig.venues);

const publicStreamPool = streamConnectors.size > 0
  ? new PublicStreamPool(publicStreamConfig, streamConnectors)
  : undefined;

// Worker-scoped oracle mark source (stateless, safe to share)
const oracleMarkSource = new OracleMarkSource({
  baseUrl: appConfig.marking.oracleBaseUrl,
  timeoutMs: appConfig.marking.oracleTimeoutMs,
  vsCurrency: appConfig.marking.oracleVsCurrency,
  instrumentToCoinId: appConfig.marking.instrumentToCoinId ?? {},
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
      instanceUserIds.delete(botId);
    },
    onStopped: async (instanceId: string) => {
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
      instanceUserIds.delete(instanceId);
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

    const strategy = createStrategy(config.strategy);

    const venueAccountId = (rawConfig['venueAccountId'] as string) ?? rawConfig['venue_account_id'] as string;
    if (!venueAccountId) {
      throw new Error(`Bot ${botId} has no venueAccountId in job config — refusing to start`);
    }
    const instanceUserId = rawConfig['userId'] as string | undefined;
    let apiKey = '';
    let secret = '';
    let walletAddress = '';
    let testnet = false;
    let credentialsFromDb = false;
    let resolvedCredentialId: string | undefined;

    // Credential resolution is only needed for orderbook venues (exchange API keys).
    // Swap venues are wallet-only — they resolve their address from venueAccountRef later.
    if (config.venueType !== 'swap') {
      let pendingCredentialId: string | undefined;
      try {
        const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
        if (account?.credentialId) {
          pendingCredentialId = account.credentialId;
          const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, account.credentialId)).limit(1);
          if (cred) {
            const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
            if (encryptionKey) {
              const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { apiKey: string; secret: string; walletAddress?: string; testnet?: boolean };
              apiKey = decrypted.apiKey;
              secret = decrypted.secret;
              walletAddress = decrypted.walletAddress || walletAddress;
              testnet = decrypted.testnet ?? false;
              credentialsFromDb = true;
              resolvedCredentialId = account.credentialId;
              journal.append(credentialDecryptedEvent({
                credentialId: account.credentialId,
                venue: config.venue,
                venueAccountId,
                botId,
                outcome: 'success',
              })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            } else {
              journal.append(credentialDecryptedEvent({
                credentialId: account.credentialId,
                venue: config.venue,
                venueAccountId,
                botId,
                outcome: 'failure',
                error: 'CREDENTIAL_ENCRYPTION_KEY not set',
              })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
              throw new CredentialResolutionError(`CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt credentials for venueAccount ${venueAccountId}`);
            }
          } else {
            journal.append(credentialDecryptedEvent({
              credentialId: account.credentialId,
              venue: config.venue,
              venueAccountId,
              botId,
              outcome: 'failure',
              error: 'Credential record not found (dangling reference)',
            })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
          }
        } else if (config.execution.mode !== 'paper') {
          throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
        } else {
          logger.warn({ venueAccountId, botId }, 'Paper mode: venue account has no linked credential — proceeding without credentials');
        }
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        // Decrypt or parse failed — emit failure audit before re-throwing
        if (pendingCredentialId) {
          journal.append(credentialDecryptedEvent({
            credentialId: pendingCredentialId,
            venue: config.venue,
            venueAccountId,
            botId,
            outcome: 'failure',
            error: err instanceof Error ? err.message : String(err),
          })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: pendingCredentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
        }
        throw new CredentialResolutionError(`Failed to load credentials for venueAccount ${venueAccountId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Live-mode startup gate (fail-closed) ---
    const liveGateResult = assertLiveReadiness(appConfig.liveRollout, {
      executionMode: config.execution.mode,
      venue: config.venue,
      venueType: config.venueType,
      venueAccountId,
      credentialsFromDb,
      credentialsPresent: !!(apiKey.trim() && secret.trim()),
      driftAlertOnly: appConfig.reconciliation.driftAlertOnly,
      instanceMaxOrderNotional: config.risk.maxOrderNotional,
    });

    // Stream config (shared between adapter construction and actor deps)
    const streamConfig = appConfig.streams.private;

    // Construct venue adapters based on venueType
    const venueAdapter = config.venueType !== 'swap'
      ? config.venue === 'bybit'
        ? new BybitAdapter({
            credentials: { apiKey, secret, testnet },
            wsUrl: bybitVenueConfig?.wsUrl,
            wsPrivateUrl: bybitVenueConfig?.wsPrivateUrl,
            wsTestnetPrivateUrl: bybitVenueConfig?.wsTestnetPrivateUrl,
            streamConfig,
          })
        : new HyperliquidAdapter({
            credentials: { apiKey, secret, walletAddress, testnet },
            wsUrl: appConfig.venues['hyperliquid']?.wsUrl,
            testnetBaseUrl: appConfig.venues['hyperliquid']?.testnetBaseUrl,
            testnetWsUrl: appConfig.venues['hyperliquid']?.testnetWsUrl,
            streamConfig,
          })
      : undefined;

    // Construct swap venue adapter when venueType is 'swap'
    const swapVenue = config.venueType === 'swap'
      ? await (async () => {
          // swapAssets is required for swap venues — fail fast if missing
          if (!config.swapAssets) {
            throw new CredentialResolutionError(
              `swapAssets config required for swap venue bot ${botId} — cannot route swaps without explicit asset identifiers and decimals`,
            );
          }
          // Build token decimals map from configured swap assets
          const tokenDecimals: Record<string, number> = {
            [config.swapAssets.baseAsset]: config.swapAssets.baseDecimals,
            [config.swapAssets.quoteAsset]: config.swapAssets.quoteDecimals,
          };

          if (config.venue === '1inch') {
            // 1inch requires a private key and API key — resolved from DB credential
            let privateKey: string | undefined;
            let oneInchApiKey: string | undefined;
            const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
            if (account?.credentialId) {
              const [cred] = await db.select().from(userCredentials).where(eq(userCredentials.id, account.credentialId)).limit(1);
              const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
              if (cred && encryptionKey) {
                try {
                  const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { privateKey: string; apiKey: string };
                  privateKey = decrypted.privateKey;
                  oneInchApiKey = decrypted.apiKey;
                  journal.append(credentialDecryptedEvent({
                    credentialId: account.credentialId,
                    venue: config.venue,
                    venueAccountId,
                    botId,
                    outcome: 'success',
                  })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
                } catch (decryptErr) {
                  journal.append(credentialDecryptedEvent({
                    credentialId: account.credentialId,
                    venue: config.venue,
                    venueAccountId,
                    botId,
                    outcome: 'failure',
                    error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
                  })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
                  throw new CredentialResolutionError(`Failed to decrypt 1inch credentials for venueAccount ${venueAccountId}: ${decryptErr instanceof Error ? decryptErr.message : String(decryptErr)}`);
                }
              } else if (!encryptionKey && cred) {
                journal.append(credentialDecryptedEvent({
                  credentialId: account.credentialId,
                  venue: config.venue,
                  venueAccountId,
                  botId,
                  outcome: 'failure',
                  error: 'CREDENTIAL_ENCRYPTION_KEY not set',
                })).catch((auditErr) => { logger.error({ err: auditErr, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
                throw new CredentialResolutionError(`CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt 1inch credentials for venueAccount ${venueAccountId}`);
              } else {
                throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
              }
            } else {
              throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential — cannot resolve 1inch secrets`);
            }
            if (!privateKey) {
              throw new CredentialResolutionError(
                `privateKey required for 1inch venue bot ${botId}. Store in DB credential.`,
              );
            }
            if (!oneInchApiKey) {
              throw new CredentialResolutionError(
                `apiKey required for 1inch venue bot ${botId}. Store in DB credential.`,
              );
            }
            const oneInchConfig = appConfig.venues['1inch'];
            return new OneInchSwapAdapter({
              apiUrl: oneInchConfig?.baseUrl ?? 'https://api.1inch.dev/swap/v6.0/8453',
              apiKey: oneInchApiKey,
              signer: {
                privateKey,
                rpcUrl: oneInchConfig?.rpcUrl ?? 'https://mainnet.base.org',
                chainId: oneInchConfig?.chainId ?? 8453,
                confirmationTimeoutMs: oneInchConfig?.confirmationTimeoutMs ?? appConfig.execution.orderTimeoutMs,
              },
              rateLimitPerSec: oneInchConfig?.rateLimitPerSec,
              tokenDecimals,
              timeoutMs: oneInchConfig?.timeoutMs,
              routerAddress: oneInchConfig?.routerAddress,
            });
          }

          // Non-1inch swap venues (Jupiter) require a wallet address on the venue account
          const [swapAccount] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
          if (!swapAccount?.venueAccountRef) {
            throw new CredentialResolutionError(
              `Venue account ${venueAccountId} has no venueAccountRef — cannot resolve wallet address for swap venue bot ${botId}`,
            );
          }
          const walletAddress = swapAccount.venueAccountRef;

          return new JupiterSwapAdapter({
            walletAddress,
            apiUrl: appConfig.venues['jupiter']?.baseUrl,
            rpcUrl: appConfig.venues['jupiter']?.rpcUrl,
            tokenDecimals,
            timeoutMs: appConfig.venues['jupiter']?.timeoutMs,
          });
        })()
      : undefined;

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
      const recorder = new MarketDataRecorder(config.venue);
      const corpusId = await backtestingRepo.insertCorpus({
        name: `${botId}-${new Date().toISOString()}`,
        source: 'live-recording',
        venue: config.venue,
        symbols: [config.symbol],
        userId: instanceUserId,
        metadata: {
          botId,
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

    const swapNetwork = config.venueType !== 'swap'
      ? undefined
      : config.venue === 'jupiter'
        ? 'solana'
        : appConfig.venues['1inch']?.tokenSafetyNetwork
          ?? inferOneInchTokenSafetyNetwork(appConfig.venues['1inch']?.chainId);

    if (config.venueType === 'swap' && config.venue === '1inch' && appConfig.marketData?.tokenSafety?.enabled && !swapNetwork) {
      throw new CredentialResolutionError(
        `Unsupported 1inch chainId ${String(appConfig.venues['1inch']?.chainId)} for token safety on bot ${botId}`,
      );
    }

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
        maxOrderNotional: liveGateResult.effectiveMaxOrderNotional,
      },
      idGen,
      fetchPrice,
      venuePort: config.execution.mode === 'paper' ? undefined : (venueAdapter ?? undefined),
      reconciliationConfig,
      executionMode: config.execution.mode,
      streamConfig,
      venue: config.venue,
      symbol: config.symbol,
      venueAccountId,
      venueType: config.venueType,
      swapAssets: config.swapAssets,
      swapNetwork,
      swapBaseTokenAddress: config.venueType === 'swap' ? config.swapAssets?.baseAsset : undefined,
      swapVenue,
      streamPool: config.venueType !== 'swap'
        ? createScopedStreamPoolHandle(publicStreamPool, config.venue, testnet)
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
        },
    };
    const actor = new TradingActor(botId, config.strategy.params as Record<string, unknown>, deps);
    actorRegistry.set(botId, actor);
    // Record userId so onStarted / onStartFailed / onStopped callbacks can publish events.
    if (instanceUserId) instanceUserIds.set(botId, instanceUserId);
    try {
      await agentStreamConsumer.subscribe(botId);
    } catch (err: unknown) {
      actorRegistry.delete(botId);
      instanceUserIds.delete(botId);
      throw err;
    }
    return actor;
  },
  async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(bots).where(eq(bots.status, 'running'));
    return running.map((row) => ({
      id: row.id,
      config: { ...row.config, venueAccountId: row.venueAccountId, userId: row.userId },
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
        },
        { redis: redisClient, providerRegistry: sharedMarketDataRegistry!, publisher: eventPublisher, monitor: marketMonitor },
      );
      return coordinator;
    })()
  : undefined;

marketIntelCoordinator?.start();

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
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
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

sessionManager.start();
agentHealthMonitor.start();
reminderCoordinator.start();
logger.info({ workerId, queue: QUEUE_NAME }, 'Worker process started');
