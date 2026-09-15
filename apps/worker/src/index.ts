import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { EvaluationRuntime } from './agent-evaluation/index.js';
import { ManualReviewRuntime } from './manual-review-runtime.js';
import type { ManualReviewRunnerFactory } from './manual-review-runtime.js';
import {
  AssessmentReviewRunner,
} from './market-intelligence/assessment-review-runner.js';
import { fetchOpenRouterPricing } from '@herobids/llm';
import { createDatabase, PgJournal, AlertDeliveryRepository, AgentRepository, BotRepository, UsageBillingRepository, AgentDocumentsRepository, DecisionApprovalRepository, users, agents } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { AGENT_STREAM_MAXLEN, type ProvidersYaml, ok, err } from '@herobids/domain';

import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, MONOREPO_CONFIG_DIR } from './config.js';
import { AlertDispatcher } from './alerting/index.js';
import { TelegramClient, forceReply, PlatformAlertService, createEmailClient } from './alerting/index.js';
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
import { createTradertonClient } from '@herobids/domain/traderton';
import type { TradertonSubject } from '@herobids/domain/traderton';
import { createTradertonSideEffectBoundary } from './traderton/write-adapter.js';
import { createTradertonReadBoundary } from './traderton/read-adapter.js';
import { ApprovalService } from './services/approval-service.js';
import { DockerAgentManager } from './agents/docker-agent-manager.js';
import { DockerRuntimeDocumentMaterializer } from './agents/docker-document-materializer.js';
import { StubRuntimeDocumentMaterializer } from './agents/stub-document-materializer.js';
import { LocalDocumentStore } from '@herobids/documents';
import { UserEventPublisher } from './user-event-publisher.js';
import { createMarketDataCoordinator, createMarketMonitor, createReviewScheduler, PresetTransitionService, resolveActivePresetState } from './market-intelligence/index.js';
import type { TriggeredWatch } from './market-intelligence/index.js';
import type { ReviewScheduler } from './market-intelligence/index.js';
import { createPlatformAssessor } from './market-intelligence/assessor-factory.js';
import { createPresetCatalog } from './market-intelligence/preset-catalog-adapter.js';
import { createEvidencePorts } from './market-intelligence/evidence-adapters.js';
import { AssessmentRequestService } from './market-intelligence/assessment-request-service.js';
import { setAssessmentRequestPort } from './tools/assess-strategy-preset.js';
import { setPresetTransitionPort } from './tools/change-strategy-preset.js';
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

// Load operator config: default.yaml → {NODE_ENV}.yaml → env var overrides
const appConfig = loadConfig();

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
const journal = new PgJournal(db);
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

// Bot repository — vestige read surface (Traderton owns bot lifecycle; the
// in-process cascade-stop path was removed in L3d-5).
const botRepo = new BotRepository(db);

// Build the agentRuntimeConfigJson once — shared between the Docker manager
// config and any future runtime adapter config.
const agentRuntimeConfigJson = JSON.stringify({
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
    ...(appConfig.externalSkills.enabled
      ? { externalSkillsConfigJson: JSON.stringify(appConfig.externalSkills) }
      : {}),
    // Traderton boundary config (L3b): forwarded so the agent can route read
    // tools over REST. The agent itself gates on baseUrl/hmacSecret/ownerId
    // before enabling the boundary path.
    boundaryConfigJson: JSON.stringify(appConfig.boundary),
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
        boundaryConfigJson: JSON.stringify(appConfig.boundary),
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

// L3c: construct the Traderton side-effecting boundary from operator config
// (appConfig.boundary). When baseUrl + hmacSecret are unset (unconfigured), leave
// it undefined so the handler/broker return a typed precondition — NO silent
// fallback to the in-process engine (differs from L3b's read fallback). The HMAC
// secret lives only in the client; it never reaches a tool.
const sideEffectBoundary = (() => {
  const b = appConfig.boundary;
  if (!b.baseUrl || !b.hmacSecret) {
    logger.info(
      { hasBaseUrl: !!b.baseUrl, hasSecret: !!b.hmacSecret },
      'Traderton side-effecting boundary not configured — submit_decision + bot lifecycle will return precondition.not_ready',
    );
    return undefined;
  }
  const client = createTradertonClient({
    baseUrl: b.baseUrl,
    consumerId: b.consumerId,
    keyId: b.keyId,
    hmacSecret: b.hmacSecret,
    requestTimeoutMs: b.requestTimeoutMs,
  });
  logger.info({ baseUrl: b.baseUrl }, 'Traderton side-effecting boundary enabled — submit_decision + bot lifecycle route over REST');
  return createTradertonSideEffectBoundary(client);
})();

// L3 Q2: a SYSTEM-subject read boundary for the shared worker's market-intel
// read tools (`score_candidate`, `check_regime`). Unlike the per-agent read
// boundary (built in the agent container with an agent subject), this runs in
// the shared worker process and serves platform-owned market intelligence, so
// it binds a fixed SYSTEM subject. `score_candidate`/`check_regime` are
// read-market-data — the boundary resolver short-circuits, so a system subject
// suffices. Undefined when the boundary is unconfigured (baseUrl/hmacSecret
// absent) — callers then propagate a typed "boundary unavailable" outcome.
const systemReadBoundary = (() => {
  const b = appConfig.boundary;
  if (!b.baseUrl || !b.hmacSecret) {
    logger.info(
      { hasBaseUrl: !!b.baseUrl, hasSecret: !!b.hmacSecret },
      'Traderton system read boundary not configured — market-intel scoring/regime tools return a typed boundary-unavailable outcome',
    );
    return undefined;
  }
  const client = createTradertonClient({
    baseUrl: b.baseUrl,
    consumerId: b.consumerId,
    keyId: b.keyId,
    hmacSecret: b.hmacSecret,
    requestTimeoutMs: b.requestTimeoutMs,
  });
  const subject: TradertonSubject = {
    ownerId: b.consumerId,
    actor: { type: 'system', id: 'market-intel' },
  };
  logger.info({ baseUrl: b.baseUrl }, 'Traderton system read boundary enabled — market-intel scoring/regime route over REST');
  return createTradertonReadBoundary(client, subject, b.requestTimeoutMs);
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

const agentDecisionHandler = new AgentDecisionHandler(
  agentRepo,
  eventPublisher,
  {
    noContext: appConfig.agentRiskDefaults.agentDecisionNoContextThreshold,
    swapInstrumentFormat: appConfig.agentRiskDefaults.agentDecisionSwapInstrumentFormatThreshold,
  },
  decisionApprovalRepo,
  appConfig.agentApprovals.ttlMs,
  appConfig.alerts.telegram.botToken || undefined,
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

const platformAlerts = new PlatformAlertService(agentRepo, workerTelegram, appConfig.alerts.telegram.botToken || undefined, workerEmail, appConfig.alerts.email.brandImageUrl);

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
  onSessionActive: (agentId, _executionMode, _sessionId) => {
    // L3d-5: trading agents no longer spin up an in-process AgentTradingActor —
    // execution routes over the Traderton boundary via agentDecisionHandler. A
    // session is simply activated here (the same shape a non-trading agent has
    // always had): mark it active + start the platform review scheduler (gated
    // internally on hybrid + platformAssessment.enabled + operator switch). With
    // no async actor start to protect, activation is established synchronously.
    return (async (): Promise<boolean> => {
      const agent = await agentRepo.getAgent(agentId);
      if (agent) {
        // Worker startup is not the sole lifecycle hook for review schedulers
        // (see 010-scanner-pre-check.md) — start one here for agents that opt
        // into platform assessment and become active after boot.
        startReviewSchedulerForAgent(agent);
      }
      return true;
    })();
  },
  onSessionStopped: (agentId, _sessionId) => {
    stopReviewSchedulerForAgent(agentId);
  },
  onSessionStarted: (agentId, sessionId) => sendSessionStartedTelegramAnchor(agentId, sessionId),
  usageBillingRepo: new UsageBillingRepository(db, appConfig.usageBilling.defaultRateCardItems, providersYaml, appConfig.usageBilling.fallbackCacheReadPct),
  plansConfig: appConfig.plans,
  usageBillingConfig: appConfig.usageBilling,
  providersYaml,
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

const agentBroker = new AgentMessageBroker(
  redisClient,
  agentRepo,
  agentDecisionHandler,
  sessionManager,
  eventPublisher,
  workerTelegram,
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
);
const agentStreamConsumer = new AgentStreamConsumer(redisClient, agentBroker);
agentStreamSubscribeFn = (agentId: string) => agentStreamConsumer.subscribe(agentId);
const agentHealthMonitor = new AgentHealthMonitor(
  db,
  sessionManager,
  {
    // L3d-5: the onTerminalSessionCleanup cascade-stop of an agent's in-process
    // bots was removed — Traderton owns bot lifecycle. No terminal-cleanup hook
    // is needed here anymore.
    checkIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
  },
  agentRuntimeLauncher,
);

const reminderCoordinator = new ReminderCoordinator(redisClient, agentRepo, eventPublisher);

// L3d-5: the strategy factory (createStrategy) + reconciliation config were only
// consumed by the deleted in-process trading actors. Removed with the actor slice.

// Traderton read client for the evaluation runtime — sources agent trading
// evidence (fills / journal / positions) over the boundary. Uses the SAME
// operator config as the system read boundary. When unconfigured (baseUrl /
// hmacSecret absent), leave it undefined: the per-agent evidence port then
// fails closed at invocation time (evaluation of trading evidence cannot
// proceed without the boundary) — mirroring the fail-fast boundary posture.
const evaluationReadClient = (() => {
  const b = appConfig.boundary;
  if (!b.baseUrl || !b.hmacSecret) {
    logger.info(
      { hasBaseUrl: !!b.baseUrl, hasSecret: !!b.hmacSecret },
      'Traderton read boundary not configured for evaluation — agent evidence port will fail closed',
    );
    return undefined;
  }
  return createTradertonClient({
    baseUrl: b.baseUrl,
    consumerId: b.consumerId,
    keyId: b.keyId,
    hmacSecret: b.hmacSecret,
    requestTimeoutMs: b.requestTimeoutMs,
  });
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
    tradertonReadTimeoutMs: appConfig.boundary.requestTimeoutMs,
  },
  db,
);
evaluationRuntime.start();

// Start manual review runtime (BullMQ consumer for user-triggered platform assessment reviews)
const manualReviewRuntime = new ManualReviewRuntime(
  {
    redis: redisConnection,
    concurrency: 2,
    maxRuntimeMs: 120_000,
  },
  db,
  // Runner factory — creates a per-agent AssessmentReviewRunner on each job.
  // Uses the same deps construction pattern as startReviewSchedulerForAgent.
  (async (agentId: string) => {
    try {
      // Load agent config
      const [agent] = await db
        .select({
          id: agents.id,
          userId: agents.userId,
          unifiedConfig: agents.unifiedConfig,
          strategy: agents.strategy,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agent) {
        return err({ code: 'review.agent_not_found', message: `Agent ${agentId} not found` });
      }

      const unifiedConfig = (agent.unifiedConfig ?? {}) as Record<string, unknown>;

      // Defense-in-depth: preset review is only meaningful for hybrid agents.
      // If a job somehow reaches the worker for a non-hybrid agent (stale
      // enqueue, race), reject cleanly so the run terminates instead of
      // executing against a non-existent preset.
      // TEST-MIRROR: review-scheduler-lifecycle-wiring.test.ts mirrors this gate in resolveManualReviewFactoryCapabilityGate()
      if (unifiedConfig['capabilityMode'] !== 'hybrid') {
        return err({ code: 'review.capability_mode_unsupported', message: 'Strategy review is only available for hybrid agents' });
      }

      const platformAssessment = (unifiedConfig['platformAssessment'] ?? {}) as Record<string, unknown>;
      const agentEnabled = platformAssessment['enabled'] === true;
      if (!agentEnabled) {
        return err({ code: 'review.not_enabled', message: 'Platform assessment is not enabled for this agent' });
      }

      const agentReviewIntervalMs = (typeof platformAssessment['reviewIntervalMs'] === 'number')
        ? platformAssessment['reviewIntervalMs']
        : appConfig.platformAssessor.minReviewIntervalMs;

      const resolveActivePreset = () => resolveActivePresetState(db, { id: agentId, unifiedConfig: agent.unifiedConfig, strategy: agent.strategy });

      // Billing preflight
      const checkBillingEligibility = async () => {
        try {
          if (!agent.userId) return ok(false);
          const account = await usageBillingRepo.getAccountByUserId(agent.userId);
          if (!account) return ok(false);
          return ok(account.status === 'active');
        } catch {
          return ok(true);
        }
      };

      const runner = new AssessmentReviewRunner(
        {
          db,
          agentId,
          eventPublisher,
          resolveActivePreset,
          checkBillingEligibility,
          assessmentRequestPort: assessmentRequestService,
        },
        {
          reviewIntervalMs: Math.max(agentReviewIntervalMs, appConfig.platformAssessor.minReviewIntervalMs),
          minReviewIntervalMs: appConfig.platformAssessor.minReviewIntervalMs,
          scannerCandidateLimit: appConfig.platformAssessor.scannerCandidateLimit,
          cacheFreshnessMs: appConfig.platformAssessor.cacheFreshnessMs,
          adviceExpiryMs: appConfig.platformAssessor.cacheFreshnessMs,
          preCheck: appConfig.platformAssessor.preCheck ?? {
            signalRatioThreshold: 2.0,
            scanMetricsLookbackMs: 86_400_000,
            minSignalsForActive: 3,
            identityCooldownMs: 86_400_000,
            candidateMaxAgeMs: 86_400_000,
            policyVersion: '1.0.0',
            enablePeerComparison: true,
          },
          maxAssessmentsPerReview: appConfig.platformAssessor.maxInstrumentsPerRequest,
        },
      );

      return ok({ runner });
    } catch (error) {
      return err({ code: 'review.runner_factory_failed', message: (error as Error).message });
    }
  }) as ManualReviewRunnerFactory,
);
manualReviewRuntime.start();

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

// B3-monitor: watch evaluation authority lives in Traderton. This port invokes
// the owner-scoped `check_watches` over the side-effecting boundary and returns
// the edge-up triggered watches + edge-down reset watchIds. The monitor keeps
// all the platform wake machinery (dedupe, rate-limit, emit, enqueue). When the
// boundary is unconfigured the port is undefined and the monitor no-ops watch
// wakes (in-process eval was removed in B3 — no local fallback).
const evaluateAgentWatches = sideEffectBoundary
  ? async (agentId: string): Promise<{ triggered: TriggeredWatch[]; reset: string[] }> => {
      // Resolve the agent's owner (fail-open → empty on miss). check_watches is
      // owner-scoped, so a per-agent subject is required (the SYSTEM read
      // boundary is insufficient).
      const [row] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, agentId)).limit(1);
      const ownerId = row?.userId;
      if (!ownerId) {
        logger.warn({ agentId }, 'evaluateAgentWatches: no ownerId — skipping');
        return { triggered: [], reset: [] };
      }
      const subject: TradertonSubject = { ownerId, actor: { type: 'agent', id: agentId } };
      const result = await sideEffectBoundary.invokeAndAwait({
        toolName: 'check_watches',
        payload: { removeTriggered: false },
        subject,
        deadlineMs: 30_000,
      });
      if (result.kind !== 'success') {
        logger.warn({ agentId, kind: result.kind }, 'check_watches over boundary did not succeed');
        return { triggered: [], reset: [] };
      }
      // The boundary returns WatchEntry & { currentPrice, priceSource, stale }
      // objects that structurally match TriggeredWatch.
      const data = result.payload as { triggered?: TriggeredWatch[]; reset?: string[] };
      return {
        triggered: Array.isArray(data.triggered) ? data.triggered : [],
        reset: Array.isArray(data.reset) ? data.reset : [],
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

/** Per-agent review schedulers for agents opted into platform assessment. */
const reviewSchedulers = new Map<string, ReviewScheduler>();

// ── Platform Assessor ───────────────────────────────────────────────────────
// Construct the shared PlatformAssessor and AssessmentRequestService.
// The assessor uses platform-owned LLM configuration (never agent config).
// Evidence ports are backed by the worker's scanner candle fetcher.
// Liquidity and breadth remain explicitly unavailable in the first shipped slice.

const providersBaseUrlMap: Record<string, string> = {};
if (providersYaml?.providers) {
  for (const [key, cfg] of Object.entries(providersYaml.providers)) {
    if (cfg.baseUrl) {
      providersBaseUrlMap[key] = cfg.baseUrl;
    }
  }
}

// Real evidence ports backed entirely by the SYSTEM read boundary.
// Liquidity and breadth remain explicitly unavailable in the first shipped slice.
// L3 Q2: regime evidence routes over the boundary (check_regime).
// D1-b: candle evidence is DERIVED over the boundary (get_volatility +
// score_candidate) — no raw candles fetched in-process.
const evidencePorts = createEvidencePorts({
  checkRegimeBoundary: systemReadBoundary,
  readBoundary: systemReadBoundary,
});

const getPresets = createPresetCatalog();

const { assessor: platformAssessor, llmConfig: platformLlmConfig } = createPlatformAssessor(
  appConfig.platformAssessor,
  providersBaseUrlMap,
  db,
  redisClient,
  evidencePorts,
  getPresets,
  logger,
  appConfig.llm.openRouterProviderControls,
  // L3 Q2: orderbook/perp preset scoring routes over the SYSTEM read boundary.
  systemReadBoundary,
);

const usageBillingRepo = new UsageBillingRepository(
  db,
  appConfig.usageBilling.defaultRateCardItems,
  providersYaml,
  appConfig.usageBilling.fallbackCacheReadPct,
);

const assessmentRequestService = new AssessmentRequestService(
  db,
  usageBillingRepo,
  appConfig.platformAssessor,
  platformAssessor,
  appConfig.plans.defaultPlanId,
);

setAssessmentRequestPort(assessmentRequestService);

// ── Preset Transition Service ─────────────────────────────────────────────
// Wire the PresetTransitionPort so tools can delegate preset transitions.
//
// L3d-5: the preset transition persists to the DB (the source of truth); the
// in-process AgentTradingActor reload was removed with the actor slice —
// Traderton owns the trading runtime and reloads its own config. notifyActor
// now only emits the visibility-only `agent.runtime.config_update` event so the
// agent runtime's summary/prompt reflects the new preset/binding state. A Redis
// failure here must not fail the transition.
const presetTransitionService = new PresetTransitionService({
  db,
  notifyActor: async (agentId, activePresetKey, styleTier, behaviorVersion) => {
    try {
      await redisClient.xadd(
        `agent:outbound:${agentId}`,
        'MAXLEN', '~', AGENT_STREAM_MAXLEN,
        '*',
        'envelope',
        JSON.stringify({
          schemaVersion: 'v1',
          messageId: crypto.randomUUID(),
          correlationId: agentId,
          initiatorType: 'system',
          initiatorId: agentId,
          agentId,
          type: 'agent.runtime.config_update',
          createdAt: new Date().toISOString(),
          payload: {
            reason: 'binding_changed',
            activePresetKey,
            styleTier,
            behaviorVersion,
          },
        }),
      );
    } catch (err) {
      logger.warn({ agentId, err }, 'Failed to emit runtime config update event after preset transition');
    }

    return ok(undefined);
  },
});
setPresetTransitionPort(presetTransitionService);

logger.info(
  {
    llmConfigured: platformLlmConfig !== null,
    ...(platformLlmConfig && { provider: platformLlmConfig.provider, model: platformLlmConfig.model }),
  },
  'Platform assessor wired into worker composition root',
);

// ── Per-Agent Review Schedulers ──────────────────────────────────────────
// Creates/stops a ReviewScheduler for an agent opted into platform assessment
// (platformAssessment.enabled === true), gated on the operator-level
// platformAssessor.enabled master switch. Both gates must be true: operator
// *and* agent.
//
// Worker startup is not the sole lifecycle hook (see 010-scanner-pre-check.md):
// startReviewSchedulerForAgent() is called both from the boot-time loop below
// (for agents already active at boot) and from onSessionActive (for agents
// that become active afterward — the normal case, since agents are started
// on demand). stopReviewSchedulerForAgent() is called from onSessionStopped.
type ReviewSchedulerAgentRow = Awaited<ReturnType<typeof agentRepo.listActiveAgents>>[number];

function startReviewSchedulerForAgent(agent: ReviewSchedulerAgentRow): void {
  // Gate: preset review is only meaningful for hybrid agents
  // TEST-MIRROR: review-scheduler-lifecycle-wiring.test.ts mirrors this gate in resolveCapabilityModeGate()
  if (((agent.unifiedConfig ?? {}) as Record<string, unknown>)['capabilityMode'] !== 'hybrid') return;

  if (!appConfig.platformAssessor.enabled) return;
  if (reviewSchedulers.has(agent.id)) return; // already running — idempotent

  const unifiedConfig = (agent.unifiedConfig ?? {}) as Record<string, unknown>;
  const platformAssessment = (unifiedConfig['platformAssessment'] ?? {}) as Record<string, unknown>;
  const agentEnabled = platformAssessment['enabled'] === true;
  if (!agentEnabled) return;

  const agentReviewIntervalMs = (typeof platformAssessment['reviewIntervalMs'] === 'number')
    ? platformAssessment['reviewIntervalMs']
    : appConfig.platformAssessor.minReviewIntervalMs;

  const resolveActivePreset = () => resolveActivePresetState(db, { id: agent.id, unifiedConfig: agent.unifiedConfig, strategy: agent.strategy });

  // Read-only billing preflight — checks if the agent has an active billing account.
  const checkBillingEligibility = async () => {
    try {
      if (!agent.userId) return ok(false);
      const account = await usageBillingRepo.getAccountByUserId(agent.userId);
      if (!account) return ok(false);
      return ok(account.status === 'active');
    } catch {
      // Fail-open: if billing check fails, allow pre-check to continue
      return ok(true);
    }
  };

  const scheduler = createReviewScheduler(
    {
      db,
      redis: redisClient,
      agentId: agent.id,
      eventPublisher,
      resolveActivePreset,
      checkBillingEligibility,
    },
    agentReviewIntervalMs,
    {
      minReviewIntervalMs: appConfig.platformAssessor.minReviewIntervalMs,
      scannerCandidateLimit: appConfig.platformAssessor.scannerCandidateLimit,
      cacheFreshnessMs: appConfig.platformAssessor.cacheFreshnessMs,
      preCheck: appConfig.platformAssessor.preCheck ?? {
        signalRatioThreshold: 2.0,
        scanMetricsLookbackMs: 86_400_000,
        minSignalsForActive: 3,
        identityCooldownMs: 86_400_000,
        candidateMaxAgeMs: 86_400_000,
        policyVersion: '1.0.0',
        enablePeerComparison: true,
      },
    },
  );
  scheduler.start();
  reviewSchedulers.set(agent.id, scheduler);
  logger.info({ agentId: agent.id, reviewIntervalMs: Math.max(agentReviewIntervalMs, appConfig.platformAssessor.minReviewIntervalMs) }, 'Review scheduler started for agent');
}

function stopReviewSchedulerForAgent(agentId: string): void {
  const scheduler = reviewSchedulers.get(agentId);
  if (!scheduler) return;
  scheduler.stop();
  reviewSchedulers.delete(agentId);
  logger.info({ agentId }, 'Review scheduler stopped for agent');
}

try {
  if (!appConfig.platformAssessor.enabled) {
    logger.info('Platform assessor is disabled at operator level — skipping review scheduler initialisation');
  } else {
    const activeAgents = await agentRepo.listActiveAgents();
    for (const agent of activeAgents) {
      startReviewSchedulerForAgent(agent);
    }
    logger.info({ count: reviewSchedulers.size }, 'Review schedulers initialised');
  }
} catch (err) {
  logger.error({ err }, 'Failed to initialise review schedulers');
}

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
  reminderCoordinator.stop();
  marketMonitor.stop();
  // Stop per-agent review schedulers
  for (const scheduler of reviewSchedulers.values()) {
    scheduler.stop();
  }
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher.stop();
  await evaluationRuntime.stop();
  await manualReviewRuntime.stop();
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
  reminderCoordinator.stop();
  marketMonitor.stop();
  // Stop per-agent review schedulers
  for (const scheduler of reviewSchedulers.values()) {
    scheduler.stop();
  }
  await marketIntelCoordinator?.stop();
  await sessionManager.stop(); // stops loop only; containers keep running
  await alertDispatcher.stop();
  await evaluationRuntime.stop();
  await manualReviewRuntime.stop();
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
    const payload = JSON.parse(message) as { userId: string; resolutionSource: string; effectiveAgentId: string; effectiveBotId: string };
    const result = await approvalService.executeApproval(
      approvalId,
      payload.userId,
      payload.resolutionSource,
      payload.effectiveAgentId,
      payload.effectiveBotId,
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
