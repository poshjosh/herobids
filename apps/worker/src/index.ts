import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { EvaluationRuntime } from './agent-evaluation/index.js';
import { fetchOpenRouterPricing } from '@herobids/llm';
import { createDatabase, AlertDeliveryRepository, AgentRepository, ConnectionOwnershipRepository, UsageBillingRepository, AgentDocumentsRepository, DecisionApprovalRepository, PushSubscriptionRepository, NotificationDeliveryRepository, users, agents } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS, findExternalBackend, type ProvidersYaml } from '@herobids/domain';

import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, MONOREPO_CONFIG_DIR, resolveConfiguredExternalBackend } from './config.js';
import { AlertDispatcher, createBoundaryTradeEventFeed } from './alerting/index.js';
import { TelegramClient, PlatformAlertService, OperatorNotifier, createEmailClient } from './alerting/index.js';
import { TelegramChannel } from './alerting/telegram-channel.js';
import { ChatDelivery } from './alerting/chat-delivery.js';
import { WebPushChannel } from './notifications/web-push-channel.js';
import { createWebPushSender } from './notifications/web-push-sender.js';
import { EmailNotificationChannel } from './notifications/email-notification-channel.js';
import { NotificationDispatcher } from './notifications/notification-dispatcher.js';
import { resolveWorkerTelegramChat } from './alerting/telegram-chat-wiring.js';
import type { EmailClientConfig } from './alerting/index.js';
import {
  AgentMessageBroker,
  AgentDecisionHandler,
  AgentRuntimeLauncher,
  AgentSessionManager,
  AgentStreamConsumer,
  AgentHealthMonitor,
  AgentReconnectHandler,
  InstanceEventPublisher,
  DockerRuntimeAdapter,
  NomadRuntimeAdapter,
  NomadClient,
  buildServiceRegistry,
} from './agents/index.js';
import { buildExternalBackendClientConfig, createExternalBackendClient, createLoggerMetricsSink } from '@herobids/domain/external-backend';
import type { ExternalBackendSubject } from '@herobids/domain/external-backend';
import { createExternalBackendWriteBoundary } from './external-backend/write-adapter.js';
import { AgentActorLifecycle } from './agents/agent-actor-lifecycle.js';
import { ActorEventRelay } from './agents/actor-event-relay.js';
import { createBoundaryConsumerNotificationFeed } from './agents/boundary-consumer-notification-feed.js';
import { createExternalBackendReadBoundary } from './external-backend/read-adapter.js';
import { ApprovalService } from './services/approval-service.js';
import { DockerAgentManager } from './agents/docker-agent-manager.js';
import { DockerRuntimeDocumentMaterializer } from './agents/docker-document-materializer.js';
import { StubRuntimeDocumentMaterializer } from './agents/stub-document-materializer.js';
import { LocalDocumentStore } from '@herobids/documents';
import { UserEventPublisher } from './user-event-publisher.js';
import { createMarketDataCoordinator, createMarketMonitor } from './market-intelligence/index.js';
import type { TriggeredWatch } from './market-intelligence/index.js';
import { BrowserPoolHealthPublisher } from './browser-pool-health-publisher.js';
import { ReminderCoordinator } from './reminder-coordinator.js';
/** Slash commands registered with the Telegram Bot API so they appear in the client command picker. */
const TELEGRAM_AGENT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help', description: 'Show all commands or detailed help for one' },
  { command: 'agents', description: 'List your agents' },
  { command: 'status', description: 'Agent status overview or detail' },
  { command: 'info', description: 'Full agent details' },
  { command: 'skills', description: 'List available or assigned skills' },
  { command: 'log', description: 'Recent activity for an agent' },
  { command: 'connections', description: 'List your connections' },
  { command: 'start', description: 'Start a stopped agent' },
  { command: 'pause', description: 'Pause a running agent' },
  { command: 'resume', description: 'Resume a paused agent' },
  { command: 'stop', description: 'Stop an agent' },
  { command: 'restart', description: 'Stop then start an agent' },
  { command: 'mode', description: 'Show or set execution mode' },
  { command: 'connect', description: 'Grant or set up a connection' },
  { command: 'disconnect', description: 'Revoke a connection' },
  { command: 'to', description: 'Send a message to an agent' },
];

const logger = createLogger('herobids-worker');

// One metrics sink per worker process, reused across every external-backend
// client built below. metrics: see docs/tech/architecture/observability.md
const externalBackendMetricsSink = createLoggerMetricsSink(createLogger('external-backend-metrics'));

// Load operator config: default.yaml → {NODE_ENV}.yaml → env var overrides
const appConfig = loadConfig();

// The first-party trading call sites bind to the registry entry named by
// tradingBackendId (P3-17). Not ok (unselected / unregistered / disabled / no
// secret) → each site below stays disabled, as an unconfigured boundary did.
const tradingBackend = resolveConfiguredExternalBackend(appConfig, appConfig.tradingBackendId);
const tradingBackendTimeoutMs =
  findExternalBackend(appConfig.externalBackends, appConfig.tradingBackendId)?.endpoint.requestTimeoutMs
  ?? DEFAULT_EXTERNAL_BACKEND_REQUEST_TIMEOUT_MS;

// Load provider registry — used by UsageBillingRepository for per-model rate card seeding
const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));

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
let agentCleanupSubscriber: Redis | undefined;
let approvalExecuteSubscriber: Redis | undefined;
let browserPoolHealthPublisher: { stop(): void } | undefined;
const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;

const db = createDatabase(appConfig.database.url);
// L3d-5: the trading repositories (fills/positions/plans/orders/balance-snapshots/
// reconciliation/decisions/backtesting/llm-artifact/instrument) were only consumed
// by the deleted in-process trading actors + engine-backed intake. Removed with the
// actor slice. Their tables remain (deferred to a later slice per 004-l3d-plan §A).
const alertDeliveryRepo = new AlertDeliveryRepository(db);
const decisionApprovalRepo = new DecisionApprovalRepository(db);

// Document store shared by API and worker — must use the same root directory.
// Default matches the API's AGENT_DOCUMENTS_DIR default.
const agentDocumentsRootDir = process.env['AGENT_DOCUMENTS_DIR'] ?? resolve(process.cwd(), 'data/agent-documents');
const documentsRepo = new AgentDocumentsRepository(db);
const documentStore = new LocalDocumentStore(agentDocumentsRootDir);

// L3d-5: the swap token-safety adapter (swapTokenSafety) was only consumed by the
// deleted in-process trading actors + engine-backed intake. Removed with the actor
// slice.

// D1-b: the in-process market-data registry (`createProviderRegistry`) and the
// scanner candle fetcher (`createScannerCandleFetcher`) were the LAST market-data
// authority in the worker process — their sole consumer was the market-assessment
// evidence path. That path now sources DERIVED evidence over the SYSTEM read
// boundary (get_volatility + score_candidate; see createEvidencePorts below), so
// the registry + fetcher are removed. No raw candles are fetched in-process.

// L3d-5: the cross-scan candle-fetch circuit breaker + in-cycle retry config
// were only wired into the deleted in-process AgentTradingActor scan loop.
// Removed with the actor slice.

// Agent subsystem — protocol stack.
const agentRepo = new AgentRepository(db);
const eventPublisher = new InstanceEventPublisher(redisClient);
const userEventPublisher = new UserEventPublisher(redisClient);

// Runtime backend selection — config-driven with env var override.
// Priority: RUNTIME_BACKEND env var > appConfig.runtimeBackend > 'docker' (default).
// Legacy AGENT_RUNTIME_MODE is still honoured as a fallback for existing deployments.
const runtimeBackend = (process.env['RUNTIME_BACKEND']
  ?? appConfig.runtimeBackend
  ?? process.env['AGENT_RUNTIME_MODE']
  ?? 'docker') as 'docker' | 'nomad' | 'stub';
logger.info({ backend: runtimeBackend }, 'Runtime backend');

if ((runtimeBackend === 'docker' || runtimeBackend === 'nomad') && !appConfig.llm.provider) {
  logger.fatal('llm.provider config is required for Docker and Nomad runtime backends');
  process.exit(1);
}

if (runtimeBackend === 'nomad' && !appConfig.nomad?.addr) {
  logger.fatal('nomad.addr config is required when runtimeBackend is nomad');
  process.exit(1);
}

// Connection ownership repository — the sole surviving vestige read surface
// (Traderton owns bot lifecycle; the in-process cascade-stop path was removed
// in L3d-5).
const botRepo = new ConnectionOwnershipRepository(db);

// Build the agentRuntimeConfigJson once — shared between the Docker manager
// config and any future runtime adapter config.
const { telegram: telegramChat, alerts: alertsWithTelegramChat } = resolveWorkerTelegramChat(appConfig);
const operatorFaultReportingEnabled = Boolean(
  appConfig.alerts.operator.telegramChatId && telegramChat.botToken,
);
const agentRuntimeConfigJson = JSON.stringify({
  ...appConfig.agentRuntime,
  platformFaultReporting: operatorFaultReportingEnabled,
  llm: {
    retry: appConfig.llm.retry,
    scout: {
      ...appConfig.llm.scout,
      ...appConfig.agentRuntime.llm.scout,
    },
    judge: appConfig.agentRuntime.llm.judge,
    thinking: appConfig.llm.thinking,
  },
});

const agentRuntimeLauncher = await (async () => {
  // ── Service Registry ──────────────────────────────────────────────────
  // Build a NomadClient when running on Nomad — shared by the runtime
  // adapter and the service registry.
  const nomadClient = runtimeBackend === 'nomad'
    ? new NomadClient({
      addr: appConfig.nomad.addr,
      token: appConfig.nomad.token,
      timeoutMs: appConfig.nomad.requestTimeoutMs,
    })
    : undefined;

  // Static URLs from operator config — the ServiceRegistry uses these as
  // overrides before falling back to Nomad service discovery.
  const staticServiceUrls: Record<string, string> = {};
  for (const [name, entry] of Object.entries(appConfig.services)) {
    if (entry.url) staticServiceUrls[name] = entry.url;
  }

  const serviceRegistry = buildServiceRegistry(runtimeBackend, staticServiceUrls, nomadClient);

  // Resolve the browser pool URL from the registry (static or Nomad discovery).
  // This replaces the previous static `appConfig.browserPool.url` path for env
  // forwarding while keeping `browserPool.enabled` as the feature gate.
  let resolvedBrowserPoolUrl: string | undefined;
  if (appConfig.browserPool.enabled) {
    resolvedBrowserPoolUrl = appConfig.browserPool.url
      || ((await serviceRegistry.resolve('browser-pool')) ?? undefined);
    if (resolvedBrowserPoolUrl) {
      logger.info({ browserPoolUrl: resolvedBrowserPoolUrl }, 'Browser pool URL resolved');
    } else {
      logger.warn('browserPool.enabled is true but no URL could be resolved — browse_interactive will be unavailable');
    }
  }

  // Resolve browser pool hostname to IP for sandbox allowlist.
  // Docker service names can't resolve inside the sandbox network namespace (uses public DNS).
  let browserPoolResolvedHost: string | undefined;
  if (resolvedBrowserPoolUrl) {
    try {
      const hostname = new URL(resolvedBrowserPoolUrl).hostname;
      const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
      if (isIp) {
        browserPoolResolvedHost = hostname;
      } else {
        const result = await lookup(hostname);
        browserPoolResolvedHost = result.address;
        logger.info({ hostname, resolvedIp: browserPoolResolvedHost }, 'Resolved browser pool hostname to IP for sandbox allowlist');
      }
    } catch (err) {
      logger.warn({ err, url: resolvedBrowserPoolUrl }, 'Failed to resolve browser pool hostname for sandbox allowlist');
    }
  }

  // Browser-pool health publisher — polls Browserless instances and publishes
  // health snapshots to Redis so they appear on the admin dashboard.
  const workerDir = dirname(fileURLToPath(import.meta.url));
  let workerAppVersion = 'unknown';
  try {
    const rootPkg = resolve(workerDir, '../../../package.json');
    workerAppVersion = JSON.parse(readFileSync(rootPkg, 'utf8')).version ?? 'unknown';
  } catch { /* keep default */ }

  const bpHealthPublisher = new BrowserPoolHealthPublisher({
    redis: redisClient,
    browserPool: appConfig.browserPool,
    nomadClient,
    logger,
    appVersion: workerAppVersion,
  });
  bpHealthPublisher.start();
  browserPoolHealthPublisher = bpHealthPublisher;

  // Shared env config used by both Docker and Nomad paths
  const envConfig = {
    redisUrl: appConfig.redis.url,
    databaseUrl: appConfig.database.url,
    agentRuntimeConfigJson,
    openRouterProviderControlsJson: JSON.stringify(appConfig.llm.openRouterProviderControls),
    llmProvider: appConfig.llm.provider,
    llmBaseUrl: appConfig.llm.baseUrl,
    llmModel: appConfig.llm.model,
    llmMaxTokens: appConfig.llm.maxTokens,
    llmTimeoutMs: appConfig.llm.timeoutMs,
    llmTickIntervalMs: appConfig.llm.tickIntervalMs,
    llmHeartbeatIntervalMs: appConfig.llm.heartbeatIntervalMs,
    llmServerCostUsdPerHour: appConfig.llm.serverCostUsdPerHour,
    ...(appConfig.llm.tradingHours
      ? { llmTradingHoursJson: JSON.stringify(appConfig.llm.tradingHours) }
      : {}),
    ...(appConfig.marketData
      ? { marketDataConfigJson: JSON.stringify(appConfig.marketData) }
      : {}),
    marketDataDexscreenerBaseUrl: appConfig.marketData?.dexscreener?.baseUrl,
    marketDataDexscreenerRpm: appConfig.marketData?.dexscreener?.search?.requestsPerMinute,
    marketDataBinanceBaseUrl: appConfig.marketData?.binance?.baseUrl,
    marketDataBinanceRpm: appConfig.marketData?.binance?.requestsPerMinute,
    marketDataTimeoutMs: appConfig.marketData?.timeoutMs,
    providersYamlJson: JSON.stringify(providersYaml),
    // Pass shared-service cluster addresses so agent containers on
    // remote Nomad nodes can reach Redis/Postgres via private IPs.
    sharedServices: appConfig.sharedServices,
    apiBaseUrl: appConfig.sharedServices.apiBaseUrl,
    agentPlatformTimeoutMs: appConfig.agentCreation.platformApiTimeoutMs,
    ...(appConfig.externalSkills.enabled
      ? { externalSkillsConfigJson: JSON.stringify(appConfig.externalSkills) }
      : {}),
    // Resolved trading backend (definition + HMAC secret), forwarded so the
    // agent can route trading tools over the backend. Absent when unresolved;
    // the agent then gates its ports off (and on ownerId).
    ...(tradingBackend.ok ? { externalBackendConfigJson: JSON.stringify(tradingBackend.data) } : {}),
    ...(resolvedBrowserPoolUrl
      ? { browserPoolUrl: resolvedBrowserPoolUrl }
      : {}),
    ...(browserPoolResolvedHost
      ? { browserPoolResolvedHost }
      : {}),
    ...(appConfig.browserPool.apiKey
      ? { browserPoolApiKey: appConfig.browserPool.apiKey }
      : {}),
  };

  const defaultResources = {
    memoryLimitMb: appConfig.agentRuntime.sandboxDefaults.memoryMb,
    cpuShares: appConfig.agentRuntime.sandboxDefaults.cpuShares,
    maxProcesses: appConfig.agentRuntime.sandboxDefaults.maxProcesses,
    tempStorageMb: appConfig.agentRuntime.sandboxDefaults.tempStorageMb,
    maxWallClockMs: appConfig.agentRuntime.sandboxDefaults.maxWallClockMs,
  };

  const resourceProfiles = appConfig.agentRuntime.resourceProfiles;
  const defaultTier = appConfig.plans.defaultPlanId;

  if (runtimeBackend === 'docker') {
    const dockerManager = new DockerAgentManager(
      {
        dockerHost: process.env['DOCKER_HOST'] ?? 'tcp://docker-proxy:2375',
        dockerNetwork: process.env['DOCKER_NETWORK'] ?? 'herobids_default',
        agentImage: process.env['AGENT_IMAGE'] ?? 'herobids-agent:latest',
        redisUrl: appConfig.redis.url,
        databaseUrl: appConfig.database.url,
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
        agentRuntimeConfigJson,
        openRouterProviderControlsJson: JSON.stringify(appConfig.llm.openRouterProviderControls),
        ...(appConfig.llm.tradingHours
          ? { llmTradingHoursJson: JSON.stringify(appConfig.llm.tradingHours) }
          : {}),
        ...(appConfig.marketData
          ? { marketDataConfigJson: JSON.stringify(appConfig.marketData) }
          : {}),
        ...(appConfig.externalSkills.enabled
          ? { externalSkillsConfigJson: JSON.stringify(appConfig.externalSkills) }
          : {}),
        ...(tradingBackend.ok ? { externalBackendConfigJson: JSON.stringify(tradingBackend.data) } : {}),
        ...(resolvedBrowserPoolUrl
          ? { browserPoolUrl: resolvedBrowserPoolUrl }
          : {}),
        ...(browserPoolResolvedHost
          ? { browserPoolResolvedHost }
          : {}),
        ...(appConfig.browserPool.apiKey
          ? { browserPoolApiKey: appConfig.browserPool.apiKey }
          : {}),
        onAgentCrashed: async (agentId, sessionId?) => {
          await sessionManager.handleAgentCrashed(agentId, sessionId);
          // handleAgentCrashed does not call onSessionStopped, so stop the
          // traderton actor here too (E1-H / L3). Fire-and-forget.
          void agentActorLifecycle.stop(agentId, 'agent_crashed', sessionId);
        },
      },
      agentRepo,
      // platformAlerts is constructed later in this file — pass undefined now,
      // it is wired into the health monitor below at the AgentSessionManager level.
      undefined,
    );
    const dockerAdapter = new DockerRuntimeAdapter(dockerManager, agentRepo);
    const dockerDocMaterializer = new DockerRuntimeDocumentMaterializer(dockerManager);
    return new AgentRuntimeLauncher({
      port: dockerAdapter,
      agentRepo,
      defaultResources,
      resourceProfiles,
      defaultTier,
      agentImage: process.env['AGENT_IMAGE'] ?? 'herobids-agent:latest',
      envConfig,
      documentsRepo,
      documentStore,
      documentMaterializer: dockerDocMaterializer,
    });
  }

  if (runtimeBackend === 'nomad') {
    const nomadAdapter = new NomadRuntimeAdapter({
      nomadAddr: appConfig.nomad.addr,
      token: appConfig.nomad.token!,
      region: appConfig.nomad.region,
      datacenters: appConfig.nomad.datacenters,
      namespace: appConfig.nomad.namespace,
      agentImage: process.env['NOMAD_AGENT_IMAGE'] ?? appConfig.nomad.agentImage,
      dockerNetwork: appConfig.nomad.dockerNetwork!,
      defaultResources: {
        memoryLimitMb: defaultResources.memoryLimitMb,
        cpuShares: defaultResources.cpuShares,
        tempStorageMb: defaultResources.tempStorageMb,
        maxProcesses: defaultResources.maxProcesses,
      },
      terminationPollIntervalMs: appConfig.nomad.terminationPollIntervalMs,
      requestTimeoutMs: appConfig.nomad.requestTimeoutMs,
      nomadClient,
    });
    return new AgentRuntimeLauncher({
      port: nomadAdapter,
      agentRepo,
      defaultResources,
      resourceProfiles,
      defaultTier,
      agentImage: process.env['NOMAD_AGENT_IMAGE'] ?? appConfig.nomad.agentImage,
      envConfig,
      documentsRepo,
      documentStore,
      // Document materialization is skipped for Nomad — remote nodes
      // don't expose a Docker putArchive API from the worker.
    });
  }

  // 'stub' — in-memory fake for local dev without containers
  return new AgentRuntimeLauncher({
    redis: redisClient,
    defaultResources,
    resourceProfiles,
    defaultTier,
    documentsRepo,
    documentStore,
    documentMaterializer: new StubRuntimeDocumentMaterializer(),
  });
})();

// L3d-5: the worker-scoped mark sources (oracle / Hyperliquid mid / composite
// MarkSelector) were only consumed by the in-process trading actors + the
// engine-backed intake resolver — all removed with the actor slice. Mark
// resolution is now Traderton-owned behind the boundary.

// L3c: construct the Traderton side-effecting boundary from the trading backend
// registry entry. When it cannot be resolved (e.g. no HMAC secret), leave
// it undefined so the handler/broker return a typed precondition — NO silent
// fallback to the in-process engine (differs from L3b's read fallback). The HMAC
// secret lives only in the client; it never reaches a tool.
const sideEffectBoundary = (() => {
  if (!tradingBackend.ok) {
    logger.info(
      { backendId: appConfig.tradingBackendId, reason: tradingBackend.error.code },
      'Traderton side-effecting boundary not configured — submit_decision + bot lifecycle will return precondition.not_ready',
    );
    return undefined;
  }
  const { definition, hmacSecret } = tradingBackend.data;
  const client = createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: externalBackendMetricsSink }),
  );
  logger.info({ baseUrl: definition.endpoint.baseUrl }, 'Traderton side-effecting boundary enabled — submit_decision + bot lifecycle route over REST');
  return createExternalBackendWriteBoundary(client);
})();

// L3 Q2: a SYSTEM-subject read boundary for the shared worker's market-intel
// read tools (`score_candidate`, `check_regime`). Unlike the per-agent read
// boundary (built in the agent container with an agent subject), this runs in
// the shared worker process and serves platform-owned market intelligence, so
// it binds a fixed SYSTEM subject. `score_candidate`/`check_regime` are
// read-market-data — the boundary resolver short-circuits, so a system subject
// suffices. Undefined when the trading backend is unresolved (e.g. no HMAC
// secret) — callers then propagate a typed "boundary unavailable" outcome.
const systemReadBoundary = (() => {
  if (!tradingBackend.ok) {
    logger.info(
      { backendId: appConfig.tradingBackendId, reason: tradingBackend.error.code },
      'Traderton system read boundary not configured — market-intel scoring/regime tools return a typed boundary-unavailable outcome',
    );
    return undefined;
  }
  const { definition, hmacSecret } = tradingBackend.data;
  const client = createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: externalBackendMetricsSink }),
  );
  const subject: ExternalBackendSubject = {
    ownerId: definition.caller.consumerId,
    actor: { type: 'system', id: 'market-intel' },
  };
  logger.info({ baseUrl: definition.endpoint.baseUrl }, 'Traderton system read boundary enabled — market-intel scoring/regime route over REST');
  return createExternalBackendReadBoundary(client, subject, definition.endpoint.requestTimeoutMs);
})();

// c4.9j: a SYSTEM-subject read boundary for the AlertDispatcher's trade-event
// feed (`scan_trade_events` / `get_events_by_ids` / `get_event_by_id`). Same
// construction as `systemReadBoundary` above but with a DISTINCT system actor id
// (`alert-dispatcher` vs `market-intel`). These cross-owner reads are fenced by
// the consumer's operator-config `allowedActorTypes:['system']` grant (there is
// no per-tool allow-list in the boundary config surface — c4.9j OQ-2). Wrapped
// in the TradeEventFeed adapter the dispatcher depends on. Undefined when the
// trading backend is unresolved (e.g. no HMAC secret) — the dispatcher then
// does not start (OQ-4), mirroring `systemReadBoundary`'s undefined-when-absent
// posture and the dispatcher's own warn-and-return for a missing Telegram token.
const alertDispatcherFeed = (() => {
  if (!tradingBackend.ok) {
    logger.info(
      { backendId: appConfig.tradingBackendId, reason: tradingBackend.error.code },
      'Traderton alert-dispatcher read boundary not configured — alert dispatcher will not start',
    );
    return undefined;
  }
  const { definition, hmacSecret } = tradingBackend.data;
  const client = createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: externalBackendMetricsSink }),
  );
  const subject: ExternalBackendSubject = {
    ownerId: definition.caller.consumerId,
    actor: { type: 'system', id: 'alert-dispatcher' },
  };
  logger.info({ baseUrl: definition.endpoint.baseUrl }, 'Traderton alert-dispatcher read boundary enabled — trade-event feed routes over REST');
  return createBoundaryTradeEventFeed(createExternalBackendReadBoundary(client, subject, definition.endpoint.requestTimeoutMs));
})();

// E3-H: a SYSTEM-subject read boundary for the ActorEventRelay's consumer-
// notification feed (`scan_consumer_notifications`). Same construction as the
// alert-dispatcher feed with a DISTINCT system actor id (`actor-event-relay`).
// Undefined when the trading backend is unresolved — the relay then does not
// start, mirroring the alert-dispatcher's undefined-when-absent posture.
const actorEventRelayFeed = (() => {
  if (!tradingBackend.ok) {
    logger.info(
      { backendId: appConfig.tradingBackendId, reason: tradingBackend.error.code },
      'Traderton actor-event relay read boundary not configured — relay will not start',
    );
    return undefined;
  }
  const { definition, hmacSecret } = tradingBackend.data;
  const client = createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: externalBackendMetricsSink }),
  );
  const subject: ExternalBackendSubject = {
    ownerId: definition.caller.consumerId,
    actor: { type: 'system', id: 'actor-event-relay' },
  };
  logger.info({ baseUrl: definition.endpoint.baseUrl }, 'Traderton actor-event relay read boundary enabled — consumer-notification feed routes over REST');
  return createBoundaryConsumerNotificationFeed(createExternalBackendReadBoundary(client, subject, definition.endpoint.requestTimeoutMs));
})();

// L3c: resolve the approval-snapshot venue-account id from the connection grant
// (a KEEP platform value), NOT the engine. Picks the agent's ready trading
// connection's resolvedVenueAccountId. Returns null when none exists.
const approvalVenueAccountResolver = async (agentId: string): Promise<string | null> => {
  try {
    const descriptor = await agentRepo.getRuntimeCapabilityDescriptor(agentId);
    const trading = descriptor.grantedConnectionsByFamily['trading'] ?? [];
    const defaultConnectionId = descriptor.defaultConnectionByFamily['trading'];
    const chosen = trading.find((c) => c.connectionId === defaultConnectionId && c.readiness.effectiveReady)
      ?? trading.find((c) => c.readiness.effectiveReady);
    if (!chosen) return null;
    // c4.9i: read the resolved venue account off the chosen connection binding
    // (connections.resolvedVenueAccountId, threaded through the runtime
    // descriptor) instead of a redundant botRepo trading-table read — same
    // KEEP `connections` source, behaviour-preserving.
    return chosen.resolvedVenueAccountId ?? null;
  } catch (err) {
    logger.warn({ agentId, err }, 'Failed to resolve approval-snapshot venue account from connection grant');
    return null;
  }
};

// E1-H / L3: the agent-actor lifecycle driver. Session transitions
// (active/stopped/crashed/terminal-cleanup) start or stop the agent's traderton
// actor over the SAME side-effecting boundary the decision handler uses, so a
// scanner_gated agent's actor exists (and its scan loop runs) without the agent
// ever calling submit_decision. Fire-and-forget: never blocks or fails a
// transition. Reuses approvalVenueAccountResolver (ready trading connection →
// venue account).
const agentActorLifecycle = new AgentActorLifecycle({
  boundary: sideEffectBoundary,
  agentRepo,
  resolveVenueAccountId: approvalVenueAccountResolver,
  deadlineMs: appConfig.agentActorLifecycle.deadlineMs,
  logger,
});

const workerTelegram = telegramChat.botToken
  ? new TelegramClient(telegramChat.botToken)
  : undefined;
const chatDelivery = new ChatDelivery(agentRepo, {
    get: (provider) => provider === 'telegram' && workerTelegram ? new TelegramChannel(workerTelegram) : undefined,
  }, redisClient);

const agentDecisionHandler = new AgentDecisionHandler(
  agentRepo,
  eventPublisher,
  {
    noContext: appConfig.agentDecisionHandler.noContextThreshold,
    swapInstrumentFormat: appConfig.agentDecisionHandler.swapInstrumentFormatThreshold,
  },
  decisionApprovalRepo,
  appConfig.agentApprovals.ttlMs,
  workerTelegram ? chatDelivery : undefined,
  sideEffectBoundary,
  30_000,
  approvalVenueAccountResolver,
);

const approvalService = new ApprovalService({
  approvalRepo: decisionApprovalRepo,
  eventPublisher,
  agentApprovalsTtlMs: appConfig.agentApprovals.ttlMs,
  // L3d-1: the human-approve → execute path routes over the same Traderton
  // side-effecting boundary the decision handler uses. When unconfigured,
  // executeApproval returns a typed precondition — never the in-process engine.
  sideEffectBoundary,
  boundaryDeadlineMs: 30_000,
});

// L3d-5: the in-process actor-backed context-snapshot resolver was removed with
// the actor/runtime slice — Traderton owns live market/position state. Reconnect
// still restores session status + replays missed outbound events; it no longer
// synthesizes a local instance.context.snapshot.
const agentReconnectHandler = new AgentReconnectHandler(redisClient, agentRepo, eventPublisher, undefined, undefined);

// Platform alert service — mandatory safety alerts to users via Telegram.
// Uses the same bot token as the operator alert dispatcher.
if (!workerTelegram && telegramChat.webhookUrl) {
  logger.warn(
    'TELEGRAM_WEBHOOK_URL is set but TELEGRAM_BOT_TOKEN is not — the webhook endpoint will receive updates but the app cannot send messages or register the webhook.',
  );
}

if (workerTelegram && !telegramChat.webhookUrl) {
  logger.warn(
    'TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_URL is not — inbound Telegram messages (user replies) will NOT reach the app. ' +
    'Set TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET to enable two-way messaging.',
  );
}

if (workerTelegram && telegramChat.webhookUrl) {
  if (!telegramChat.webhookSecret) {
    logger.warn('messaging.chat.telegram.webhookUrl is configured without messaging.chat.telegram.webhookSecret; skipping Telegram webhook registration');
  } else {
    const webhookResult = await workerTelegram.setWebhook(
      telegramChat.webhookUrl,
      telegramChat.webhookSecret,
    );
    if (!webhookResult.ok) {
      logger.warn({ error: webhookResult.error }, 'Failed to register Telegram webhook');
    } else {
      logger.info({ url: telegramChat.webhookUrl }, 'Registered Telegram webhook');
    }
  }
}

// Register supported slash commands so they appear in the Telegram client command picker.
// Non-fatal: if registration fails the commands still work, they just won't show in the picker.
if (workerTelegram) {
  try {
    const commandsResult = await workerTelegram.setMyCommands(TELEGRAM_AGENT_COMMANDS);
    if (!commandsResult.ok) {
      logger.warn({ error: commandsResult.error }, 'Failed to register Telegram bot commands');
    } else {
      logger.info({ count: TELEGRAM_AGENT_COMMANDS.length }, 'Registered Telegram bot commands');
    }
  } catch (error) {
    logger.warn({ error }, 'Unexpected error registering Telegram bot commands');
  }
}

// Email client for platform-initiated emails (billing notifications, etc.).
// Agent email sending is handled via the send_email tool, not through the broker.
// Provider selection happens inside the factory; index.ts maps operator
// config to the provider-neutral EmailClientConfig.
const workerEmailConfig: EmailClientConfig = {
  provider: appConfig.alerts.email.provider as 'ses' | undefined,
  fromEmail: appConfig.alerts.email.fromEmail,
  replyToEmail: appConfig.alerts.email.replyToEmail,
  timeoutMs: appConfig.alerts.email.timeoutMs,
  ses: {
    region: appConfig.alerts.email.ses.region,
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    configurationSetName: appConfig.alerts.email.ses.configurationSetName,
  },
};
const workerEmail = createEmailClient(workerEmailConfig);

const platformAlerts = new PlatformAlertService(agentRepo, workerTelegram ? chatDelivery : undefined, telegramChat.botToken || undefined, workerEmail, appConfig.alerts.email.brandImageUrl);

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

  const text = `${agent.name} is now ready for your instructions. Reply to this message to instruct it what to do.`;
  const outboundMessageId = await agentRepo.insertOutboundMessage({
    agentId,
    sessionId,
    authoredBy: 'platform',
    subject: 'Session started',
    body: text,
    messageClass: 'reminder',
  });

  const result = await chatDelivery.send(agentId, { body: text, replyRequested: true });
  if (!result.ok) {
    await agentRepo.markOutboundMessageFailed(outboundMessageId, result.error.message).catch(() => undefined);
    logger.warn({ agentId, error: result.error }, 'Failed to send Telegram session-started anchor');
    return;
  }

  await agentRepo.markOutboundMessageSent(outboundMessageId, result.data.providerMessageId, result.data.address.address).catch(() => undefined);
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
  streamSubscribe: async (agentId: string) => agentStreamSubscribeFn?.(agentId),
  onAgentStatusChange: (agentId, userId, status) => {
    userEventPublisher.publishAgentStatus(userId, agentId, status as 'starting' | 'active' | 'stopped' | 'crashed').catch((err) => {
      logger.error({ err, agentId }, 'Failed to publish agent status event');
    });
  },
  onSessionActive: (agentId, _sessionId) => {
    // L3d-5: trading agents no longer spin up an in-process AgentTradingActor —
    // execution routes over the Traderton boundary via agentDecisionHandler. A
    // session is simply activated here (the same shape a non-trading agent has
    // always had): mark it active. With no async actor start to protect,
    // activation is established synchronously.
    // E1-H / L3: also (re)start the traderton agent-actor so a scanner_gated
    // agent's scan loop runs. Fire-and-forget — never gates activation. This
    // also re-fires after a worker restart (the activatedSessions guard is
    // empty), a harmless idempotent reconcile.
    void agentActorLifecycle.start(agentId, 'session_active');
    return Promise.resolve(true);
  },
  onSessionStopped: (agentId, sessionId) => {
    void agentActorLifecycle.stop(agentId, 'session_stopped', sessionId);
  },
  onSessionStarted: (agentId, sessionId) => sendSessionStartedTelegramAnchor(agentId, sessionId),
  usageBillingRepo: new UsageBillingRepository(db, appConfig.usageBilling.defaultRateCardItems, providersYaml, appConfig.usageBilling.fallbackCacheReadPct),
  plansConfig: appConfig.plans,
  usageBillingConfig: appConfig.usageBilling,
  providersYaml,
  generatedWalletProviders: Object.entries(appConfig.venues)
    .filter(([, venue]) => venue.walletGeneration.enabled)
    .map(([provider]) => provider),
  crashLoopGuard: appConfig.agentRuntime.crashLoopGuard,
  operatorModelDefaults: appConfig.agentRuntime.llm.modelDefaults,
}, agentReconnectHandler, platformAlerts, redisClient);

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

const operatorNotifier = operatorFaultReportingEnabled && workerTelegram
  ? new OperatorNotifier(workerTelegram, appConfig.alerts.operator.telegramChatId, appConfig.alerts.operator.faultCooldownMs)
  : undefined;

// Agent notifications (081 W5, 082 E6). Off unless messaging.notifications is enabled. The dispatcher picks one route
// per message: Web Push when configured, email fallback only when push cannot reach the user.
const pushSubscriptionRepo = new PushSubscriptionRepository(db);
const notificationsConfig = appConfig.messaging.notifications;
const webPushConfig = notificationsConfig.webPush;
const webPushKeysComplete = webPushConfig.vapidSubject !== '' && webPushConfig.vapidPublicKey !== '' && webPushConfig.vapidPrivateKey !== '';
if (notificationsConfig.enabled && webPushConfig.enabled && !webPushKeysComplete) {
  logger.warn('messaging.notifications.webPush is enabled but vapidSubject, vapidPublicKey, or VAPID_PRIVATE_KEY is missing; web push is off');
}
const agentWebPushChannel = notificationsConfig.enabled && webPushConfig.enabled && webPushKeysComplete
  ? new WebPushChannel(
    createWebPushSender({
      subject: webPushConfig.vapidSubject,
      publicKey: webPushConfig.vapidPublicKey,
      privateKey: webPushConfig.vapidPrivateKey,
    }),
    pushSubscriptionRepo,
    { ttlSeconds: webPushConfig.ttlSeconds, urgency: webPushConfig.urgency },
  )
  : undefined;
// Without a configured email client, email fallback cannot send. Say so at startup instead of failing silently.
const emailFallbackReady = notificationsConfig.enabled && notificationsConfig.email.enabled && workerEmail !== undefined;
if (notificationsConfig.enabled && notificationsConfig.email.enabled && !workerEmail) {
  logger.warn('messaging.notifications.email is enabled but no email client is configured (alerts.email); email fallback is off');
}
const agentNotificationDispatcher = notificationsConfig.enabled && (agentWebPushChannel !== undefined || emailFallbackReady)
  ? new NotificationDispatcher({
    config: notificationsConfig,
    webPush: agentWebPushChannel ? { channel: agentWebPushChannel, subscriptions: pushSubscriptionRepo } : undefined,
    email: emailFallbackReady
      ? new EmailNotificationChannel(workerEmail, agentRepo, {
        publicBaseUrl: appConfig.auth.publicBaseUrl,
        brandImageUrl: appConfig.alerts.email.brandImageUrl,
      })
      : undefined,
    deliveries: new NotificationDeliveryRepository(db),
    preferences: agentRepo,
  })
  : undefined;
const agentBroker = new AgentMessageBroker(
  redisClient,
  agentRepo,
  agentDecisionHandler,
  sessionManager,
  eventPublisher,
  chatDelivery,
  botRepo,
  botLiveCheckCallback,
  workerEmail,
  // L3d-5: onAgentConfigUpdate previously notified the in-process AgentTradingActor
  // to apply a pending config update. With the actor slice removed, there is no
  // local actor to reload — the DB is the source of truth and Traderton owns the
  // runtime reload. Pass undefined (the broker still persists/audits the event).
  undefined,
  appConfig.alerts.email.brandImageUrl,
  db,
  appConfig.agentRuntime.llm.modelDefaults,
  appConfig.plans,
  sideEffectBoundary,
  appConfig.auth.publicBaseUrl,
  appConfig.connectionRequests,
  operatorNotifier,
  agentNotificationDispatcher,
);
const agentStreamConsumer = new AgentStreamConsumer(redisClient, agentBroker);
agentStreamSubscribeFn = (agentId: string) => agentStreamConsumer.subscribe(agentId);
const agentHealthMonitor = new AgentHealthMonitor(
  db,
  sessionManager,
  {
    // E1-H / L3: terminal-cleanup is the path that catches API-initiated stops —
    // the API flips the session row directly, so the worker's stopSession
    // early-returns without onSessionStopped, and the health monitor is the only
    // place that notices. Stop the traderton actor here too. Fire-and-forget.
    onTerminalSessionCleanup: (agentId, sessionId) =>
      agentActorLifecycle.stop(agentId, 'terminal_cleanup', sessionId),
    checkIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
  },
  agentRuntimeLauncher,
);

const reminderCoordinator = new ReminderCoordinator(
  redisClient,
  agentRepo,
  eventPublisher,
  workerId,
  appConfig.agentRuntime.reminders,
);

// L3d-5: the strategy factory (createStrategy) + reconciliation config were only
// consumed by the deleted in-process trading actors. Removed with the actor slice.

// Traderton read client for the evaluation runtime — sources agent trading
// evidence (fills / journal / positions) over the boundary. Uses the SAME
// trading backend entry as the system read boundary. When unresolved (e.g. no
// HMAC secret), leave it undefined: the per-agent evidence port then
// fails closed at invocation time (evaluation of trading evidence cannot
// proceed without the boundary) — mirroring the fail-fast boundary posture.
const evaluationReadClient = (() => {
  if (!tradingBackend.ok) {
    logger.info(
      { backendId: appConfig.tradingBackendId, reason: tradingBackend.error.code },
      'Traderton read boundary not configured for evaluation — agent evidence port will fail closed',
    );
    return undefined;
  }
  const { definition, hmacSecret } = tradingBackend.data;
  return createExternalBackendClient(
    buildExternalBackendClientConfig(definition, hmacSecret, { metrics: externalBackendMetricsSink }),
  );
})();

// Start evaluation runtime (BullMQ consumer for agent evaluation jobs)
const evaluationRuntime = new EvaluationRuntime(
  {
    redis: redisConnection,
    storageRoot: appConfig.evaluation.storageRoot,
    concurrency: appConfig.evaluation.concurrency,
    maxRuntimeMs: appConfig.evaluation.maxRuntimeMs,
    thresholds: appConfig.evaluation.thresholds,
    usageBillingRepo: new UsageBillingRepository(db),
    tradertonReadClient: evaluationReadClient,
    tradertonReadTimeoutMs: tradingBackendTimeoutMs,
  },
  db,
);
evaluationRuntime.start();

// Start alert dispatcher (polls the Traderton trade-event feed → routes →
// delivers to Telegram). Uses Redis lease for singleton coordination across
// multiple workers. OQ-4: when the trade-event feed boundary is unconfigured
// the dispatcher is not constructed/started — a symmetric config-guard early
// return matching how the dispatcher already warns-and-returns for a missing
// Telegram token and how `systemReadBoundary` is undefined-when-absent.
const alertDispatcher = alertDispatcherFeed
  ? new AlertDispatcher(alertsWithTelegramChat, alertDispatcherFeed, alertDeliveryRepo, logger, redisClient, workerId)
  : undefined;
if (alertDispatcher) {
  await alertDispatcher.start();
} else {
  logger.warn('Alert dispatcher not started — Traderton trade-event feed boundary is unconfigured');
}

// E3-H: the actor-event relay republishes traderton's consumer_notifications
// (agent wakes, scans, journal, bot/agent status) onto the agent streams, so a
// scanner_gated agent receives its scanner wakes. Only constructed when the
// consumer-notification feed boundary is configured.
const actorEventRelay = actorEventRelayFeed
  ? new ActorEventRelay({
    config: appConfig.actorEventRelay,
    feed: actorEventRelayFeed,
    eventPublisher,
    userEventPublisher,
    sessionManager,
    agentRepo,
    redis: redisClient,
    workerId,
    logger,
  })
  : undefined;
if (actorEventRelay) {
  await actorEventRelay.start();
} else {
  logger.warn('Actor-event relay not started — Traderton consumer-notification feed boundary is unconfigured');
}

// Start always-on market intelligence coordinator and monitor.
// Uses Redis-based leader election so only one worker instance runs
// discovery polling and monitor evaluation at a time. The monitor is
// started and stopped by the coordinator as it gains/loses the lease,
// ensuring evaluation never races across multiple worker processes.
const miConfig = appConfig.marketIntelligence;

// B3-monitor: watch evaluation authority lives in Traderton. This port invokes
// the owner-scoped `check_watches` over the side-effecting boundary and returns
// the edge-up triggered watches + edge-down reset watchIds. The monitor keeps
// all the platform wake machinery (dedupe, rate-limit, emit, enqueue). When the
// boundary is unconfigured the port is undefined and the monitor no-ops watch
// wakes (in-process eval was removed in B3 — no local fallback).
const evaluateAgentWatches = sideEffectBoundary
  ? async (agentId: string): Promise<{ triggered: TriggeredWatch[]; reset: string[]; totalWatches?: number }> => {
      // Resolve the agent's owner (fail-open → empty on miss). check_watches is
      // owner-scoped, so a per-agent subject is required (the SYSTEM read
      // boundary is insufficient).
      const [row] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, agentId)).limit(1);
      const ownerId = row?.userId;
      if (!ownerId) {
        logger.warn({ agentId }, 'evaluateAgentWatches: no ownerId — skipping');
        return { triggered: [], reset: [] };
      }
      const subject: ExternalBackendSubject = { ownerId, actor: { type: 'agent', id: agentId } };
      // One key per evaluation, never content-derived: the payload is constant,
      // so a derived key would replay the first evaluation's result forever. Not
      // persisted — the next evaluation supersedes an unknown outcome.
      const idempotencyKey = crypto.randomUUID();
      const result = await sideEffectBoundary.invokeAndAwait({
        toolName: 'check_watches',
        payload: { removeTriggered: false },
        subject,
        deadlineMs: 30_000,
        idempotencyKey,
      });
      if (result.kind !== 'success') {
        logger.warn({ agentId, kind: result.kind, requestId: result.requestId, idempotencyKey }, 'check_watches over boundary did not succeed');
        return { triggered: [], reset: [] };
      }
      // The boundary returns WatchEntry & { currentPrice, priceSource, stale }
      // objects that structurally match TriggeredWatch, plus a watch count used
      // by the monitor's watchless backoff.
      const data = result.payload as { triggered?: TriggeredWatch[]; reset?: string[]; totalWatches?: number };
      return {
        triggered: Array.isArray(data.triggered) ? data.triggered : [],
        reset: Array.isArray(data.reset) ? data.reset : [],
        totalWatches: typeof data.totalWatches === 'number' ? data.totalWatches : undefined,
      };
    }
  : undefined;

const marketMonitor = createMarketMonitor(
  {
    enabled: miConfig.enabled && Boolean(appConfig.marketData),
    evaluationIntervalMs: miConfig.evaluationIntervalMs,
    families: {
      // B3-monitor: re-enabled — watch wakes now source triggered/reset from
      // Traderton `check_watches` via the evaluateAgentWatches port below.
      watchThresholds: miConfig.families.watchThresholds.enabled,
      discoveryDeltas: miConfig.families.discoveryDeltas.enabled,
      regimeChanges: miConfig.families.regimeChanges.enabled,
    },
    wakeCoalescingWindowMs: miConfig.wakeCoalescingWindowMs,
    wakeCooldownMs: miConfig.wakeCooldownMs,
    wakePolicy: miConfig.wakePolicy,
  },
  { redis: redisClient, publisher: eventPublisher, evaluateAgentWatches },
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
        {
          redis: redisClient,
          publisher: eventPublisher,
          monitor: marketMonitor,
          // L3 Q2: regime evaluation routes over the SYSTEM read boundary.
          checkRegimeBoundary: systemReadBoundary,
          // Discovery re-point: discovery routes over the same SYSTEM read boundary.
          discoveryBoundary: systemReadBoundary,
        },
      );
      return coordinator;
    })()
  : undefined;

marketIntelCoordinator?.start();

// ── Economic calendar acquisition (owned by Traderton — slice B6) ─────────
// The economic-calendar fetch + refresh loop now run Traderton-side. The
// herobids worker no longer scrapes Forex Factory or writes the shared cache;
// agent ticks read the calendar over the Traderton boundary
// (`get_economic_calendar`, cache-only).

// ── LLM Pricing Refresh ─────────────────────────────────────────────────────

/** Resolve the API key for a given LLM provider from environment variables. */
function resolveLlmApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

/**
 * Refresh dynamic provider pricing from their APIs and persist to DB.
 * On failure, logs a warning and keeps the existing snapshot.
 *
 * All pricing — including for formerly-static providers (OpenAI, Anthropic,
 * DeepSeek, Google) — now comes from the OpenRouter snapshot. See ADR 001
 * (eliminate-static-llm-pricing) for rationale.
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

// ── LLM Pricing — refresh dynamic pricing on startup ────────────────────────
// All provider pricing is now sourced from the OpenRouter snapshot refreshed
// here. Formerly-static providers (OpenAI, Anthropic, DeepSeek, Google) are
// cross-referenced from the same snapshot by the API catalog layer.
const pricingRepo = new UsageBillingRepository(db);

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
  clearInterval(pricingRefreshInterval);
  clearInterval(approvalExpiryInterval);
  browserPoolHealthPublisher?.stop();
  agentRuntimeLauncher.stopEventStream();
  agentHealthMonitor.stop();
  agentStreamConsumer.stop();
  marketMonitor.stop();
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher?.stop();
  await reminderCoordinator.stop(); // async: releases the Redis coordinator lease
  await actorEventRelay?.stop();
  await evaluationRuntime.stop();
  await agentRuntimeLauncher.shutdown();
  await agentCleanupSubscriber?.quit();
  await approvalExecuteSubscriber?.quit();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  clearInterval(pricingRefreshInterval);
  clearInterval(approvalExpiryInterval);
  browserPoolHealthPublisher?.stop();
  agentRuntimeLauncher.stopEventStream();
  agentHealthMonitor.stop();
  agentStreamConsumer.stop();
  marketMonitor.stop();
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher?.stop();
  await reminderCoordinator.stop(); // async: releases the Redis coordinator lease
  await actorEventRelay?.stop();
  await evaluationRuntime.stop();
  await agentRuntimeLauncher.shutdown();
  await agentCleanupSubscriber?.quit();
  await approvalExecuteSubscriber?.quit();
  await redisClient.quit();
  process.exit(0);
});

await agentStreamConsumer.start();
// Start Docker event stream for crash detection (no-op in stub mode)
await agentRuntimeLauncher.startEventStream();

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

// Subscribe to API-originated approval execution signals (approval:execute:{approvalId}).
// The API publishes to this channel when a user approves a pending approval.
// The worker validates execution context before transitioning status to 'approved'.
approvalExecuteSubscriber = new Redis(redisConnection);
approvalExecuteSubscriber.psubscribe('approval:execute:*', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to approval:execute:* channels');
});
approvalExecuteSubscriber.on('pmessage', async (_pattern: string, channel: string, message: string) => {
  const approvalId = channel.replace('approval:execute:', '');
  if (!approvalId) return;
  logger.info({ approvalId }, 'Received approval:execute signal');
  try {
    const payload = JSON.parse(message) as { userId: string; resolutionSource: string; resolutionProvider?: string | null; effectiveAgentId: string; effectiveBotId: string };
    const result = await approvalService.executeApproval(
      approvalId,
      payload.userId,
      payload.resolutionSource,
      payload.effectiveAgentId,
      payload.effectiveBotId,
      payload.resolutionProvider,
    );
    logger.info({ approvalId, result: result.kind, status: 'status' in result ? result.status : undefined }, 'Approval execution complete');
  } catch (err) {
    logger.error({ approvalId, err }, 'Failed to execute approval');
  }
});

// Periodic approval expiry sweep — expires stale pending approvals past their TTL.
const approvalExpiryInterval = setInterval(async () => {
  try {
    await approvalService.expireStaleApprovals();
  } catch (err) {
    logger.error({ err }, 'Approval expiry sweep failed');
  }
}, Math.min(appConfig.agentApprovals.ttlMs, 60_000)); // Check at most every 60s

sessionManager.start();
agentHealthMonitor.start();
reminderCoordinator.start();

logger.info({ workerId }, 'Worker process started');
