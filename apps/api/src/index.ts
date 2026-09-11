import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase, EVALUATION_QUEUE_NAME, MANUAL_REVIEW_QUEUE_NAME, UsageBillingRepository } from '@herobids/db';
import type { EvaluationJobData, ManualReviewJobData } from '@herobids/db';
import { botRoutes } from './routes/bots.js';
import { venueAccountRoutes } from './routes/accounts.js';
import { credentialRoutes } from './routes/credentials.js';
import { journalRoutes, positionRoutes } from './routes/views.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { backtestRoutes, BACKTEST_QUEUE_NAME } from './routes/backtests.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { billingRoutes } from './routes/billing.js';
import { registerGlobalErrorHandler } from './error-handler.js';
import { agentRoutes } from './routes/agents.js';
import { sessionRoutes } from './routes/sessions.js';
import { blueprintRoutes } from './routes/blueprints.js';
import { BlueprintExecutionCapabilityAdapter } from './services/blueprint-execution-capability-adapter.js';
import { agentInteractivityRoutes, telegramWebhookHandler } from './routes/agent-interactivity.js';
import { analyticsRoutes } from './routes/analytics.js';
import { aiRoutes } from './routes/ai.js';
import { chatRoutes } from './routes/chat.js';
import { ChatUsageBillingRecorder } from './billing/chat-usage-billing-recorder.js';
import { skillsRoutes } from './routes/skills.js';
import { datasetRoutes } from './routes/datasets.js';
import { agentDocumentRoutes } from './routes/agent-documents.js';
import { exportRoutes } from './routes/exports.js';
import { agentEvaluationRoutes } from './routes/agent-evaluations.js';
import { platformAssessmentReviewRoutes } from './routes/agent-platform-assessment-reviews.js';
import { actorHealthRoutes } from './routes/actor-health.js';
import { adminRoutes } from './routes/admin.js';
import { eventsRoutes } from './routes/events.js';
import { generateWallet } from '@herobids/venues';
import { toolSchemaRoutes } from './routes/tool-schemas.js';
import { agentToolsRoutes } from './routes/agent-tools.js';
import { venueDefaultsRoutes } from './routes/venue-defaults.js';
import { strategySchemaRoutes } from './routes/strategy-schemas.js';
import { loadProvidersConfig } from '@herobids/domain/config/load-providers';
import { makeCatalogContext, type LlmCatalogDeps } from './llm-model-catalog.js';
import { connectionRoutes } from './routes/connections.js';
import { connectionsOauthRoutes } from './routes/connections-oauth.js';
import { capabilityRoutes } from './routes/capabilities/index.js';
import { setupRoutes } from './routes/setup.js';
import { providerRoutes } from './routes/providers.js';
import { authPlugin } from './plugins/auth.js';
import { createAuthMailer } from './auth-mailer.js';
import { loadConfig } from './config.js';
import { ExternalSkillProviderHttp } from '@herobids/domain';
import { createTradertonClient } from '@herobids/domain/traderton';
import { createFastifyLogger } from './logger.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import type { LifecycleJob, BacktestJob } from './types.js';
import { syncSystemSkills } from './sync-system-skills.js';
import { ServerHealthPublisher } from '@herobids/domain';
import { parseAppVersion, checkPostgres, checkRedis, getRunningSessionCount, getRunningContainerCount } from './admin-utils.js';

// ---------------------------------------------------------------------------
// Process-level error handlers
// Without these, Node.js ≥ 16 crashes the process on any unhandled rejection
// or uncaught exception, which in Docker (restart: unless-stopped) causes a
// restart loop making the API intermittently unavailable (401 → ECONNREFUSED).
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[FATAL] Unhandled Rejection — the process will exit.', reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
  // eslint-disable-next-line no-console
  console.error('[FATAL] Uncaught Exception — the process will exit.', error.stack);
  process.exit(1);
});

// Mutable reference so signal handlers can stop resources declared later.
let serverHealthPublisher: { start(): void; stop(): void } | undefined;

process.on('SIGTERM', () => {
  serverHealthPublisher?.stop();
  // eslint-disable-next-line no-console
  console.error('[FATAL] SIGTERM received — the process will exit.');
  process.exit(0);
});

process.on('SIGINT', () => {
  serverHealthPublisher?.stop();
  // eslint-disable-next-line no-console
  console.error('[FATAL] SIGINT received — the process will exit.');
  process.exit(0);
});

const appConfig = loadConfig();

// Load the provider registry (providers.yaml) for LLM catalog functions.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../config');
const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));

// Custom request serializer — redacts JWT tokens from the URL query string
// while preserving all standard Fastify request log fields (id, method, url,
// query, params, headers, remoteAddress, remotePort). The Authorization
// header is redacted via Pino's built-in redact option below.
//
// The /events WebSocket endpoint passes the JWT as a ?token= query parameter
// (browsers can't set Authorization on WS upgrade). Without redaction,
// every WS connect logs the full token in plaintext.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function redactReqSerializer(req: any): Record<string, unknown> {
  // Replicate the default Pino std serializer fields so we don't drop
  // remoteAddress, remotePort, id, query, params, or headers.
  const connection: Record<string, unknown> | undefined =
    (req['socket'] as Record<string, unknown> | undefined) ??
    (req['info'] as Record<string, unknown> | undefined);
  return {
    id: typeof req['id'] === 'function' ? (req['id'] as () => string)() : (req['id'] ?? (req['raw'] as Record<string, unknown> | undefined)?.['id']),
    method: req['method'],
    url: typeof req['url'] === 'string'
      ? (req['url'] as string).replace(/([?&])token=[^&]*/g, '$1token=[redacted]').replace(/[?&]$/, '')
      : req['url'],
    query: redactQueryToken(req['query']),
    params: req['params'],
    headers: redactSensitiveHeaders(req['headers']),
    remoteAddress: req['ip'] ?? connection?.['remoteAddress'] ?? '',
    remotePort: connection?.['remotePort'] ?? undefined,
  } satisfies Record<string, unknown>;
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-telegram-bot-api-secret-token',
  'cookie',
  'x-api-key',
]);

/** Redact sensitive header values before they reach the logger. */
function redactSensitiveHeaders(headers: unknown): unknown {
  if (headers == null || typeof headers !== 'object') return headers;
  const h = headers as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(h)) {
    redacted[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[Redacted]' : value;
  }
  return redacted;
}

function redactQueryToken(query: unknown): unknown {
  if (query == null || typeof query !== 'object') return query;
  const q = query as Record<string, unknown>;
  if (!('token' in q)) return query;
  const redacted = { ...q };
  redacted['token'] = '[redacted]';
  return redacted;
}

// Fastify() infers Http2SecureServer from @types/node v25, but route
// registrations expect the default http.Server. The type assertion
// bridges the gap without weakening downstream type safety.
// We pre-build a pino instance with pino-pretty as a direct stream
// (bypassing pino v9's broken transport.target resolution inside
// pnpm deploy --prod containers).
// Fastify v5 requires custom loggers to be passed via `loggerInstance`
// (logger: <object> only accepts pino configuration, not instances).
const app = Fastify({
  loggerInstance: createFastifyLogger({ serializers: { req: redactReqSerializer } }),
}) as unknown as FastifyInstance;

const parsedRedisUrl = new URL(appConfig.redis.url);
const redisConnection = {
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.username && { username: decodeURIComponent(parsedRedisUrl.username) }),
  ...(parsedRedisUrl.pathname && parsedRedisUrl.pathname !== '/' && { db: parseInt(parsedRedisUrl.pathname.slice(1), 10) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
};

// Shared Redis client for auth exchange codes and any future short-lived server state
const redisClient = new Redis(redisConnection);
redisClient.on('error', (err: Error) => app.log.error({ err }, 'Redis client error'));

const db = createDatabase(appConfig.database.url);
await syncSystemSkills(db);
app.log.info('System skills synced');

const lifecycleQueue = new Queue<LifecycleJob>('trading-instance-lifecycle', {
  connection: redisConnection,
});

// L3c: the SECOND Traderton client — constructed at the API composition root for
// user-initiated bot side effects (POST /bots, start/stop, PATCH restart). The
// subject actor is type:'user' with ownerId = request.userId, bound per-request
// inside botRoutes. Undefined when unconfigured (no baseUrl/secret) → the write
// endpoints return a typed precondition; NO silent fallback to the lifecycle queue.
const tradertonBotClient = (appConfig.boundary.baseUrl && appConfig.boundary.hmacSecret)
  ? createTradertonClient({
      baseUrl: appConfig.boundary.baseUrl,
      consumerId: appConfig.boundary.consumerId,
      keyId: appConfig.boundary.keyId,
      hmacSecret: appConfig.boundary.hmacSecret,
      requestTimeoutMs: appConfig.boundary.requestTimeoutMs,
    })
  : undefined;

const backtestQueue = new Queue<BacktestJob>(BACKTEST_QUEUE_NAME, {
  connection: redisConnection,
});

const evaluationQueue = new Queue<EvaluationJobData>(EVALUATION_QUEUE_NAME, {
  connection: redisConnection,
});

const manualReviewQueue = new Queue<ManualReviewJobData>(MANUAL_REVIEW_QUEUE_NAME, {
  connection: redisConnection,
});

// Register auth plugin (JWT verification on all non-public routes)
await authPlugin(app, { config: appConfig.auth, db });

// Multipart file upload support (10 MiB limit)
await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });

// CORS — allow the configured frontend origin to make credentialed requests
await app.register(cors, {
  origin: [appConfig.auth.frontendOrigin],
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Global error handler — sanitises internal details (SQL, stack traces) from
// client responses. See error-handler.ts for the full specification.
registerGlobalErrorHandler(app);

// Health endpoint (public — no auth required)
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Telegram webhook — public (unauthenticated), token-validated
await telegramWebhookHandler(
  app, db, redisClient, appConfig.alerts, appConfig.auth, appConfig.agentApprovals,
  appConfig.plans,
  { db, providersYaml, context: makeCatalogContext(appConfig.llm) } satisfies LlmCatalogDeps,
  appConfig.agentRiskDefaults,
  appConfig.agentRuntime.llm.modelDefaults,
);

// Auth routes (public — Google OAuth flow + exchange endpoint)
const authMailer = createAuthMailer(appConfig.alerts, appConfig.alerts.email.brandImageUrl);
await authRoutes(app, appConfig.auth, db, redisClient, appConfig.plans.defaultPlanId, appConfig.plans, authMailer);

// ── Capability routes (primary public surface) ────────────────────────────
await capabilityRoutes(app, db, appConfig.plans, appConfig.agentRuntime.defaultBudgets, redisClient);

// ── Setup flows (guided orchestration over primitives) ────────────────────────
await setupRoutes(app, db, appConfig.plans, { venues: appConfig.venues, generateWallet });
await providerRoutes(app, appConfig.venues);

// ── Platform primitives ───────────────────────────────────────────────────
await connectionRoutes(app, db, appConfig.agentRuntime.defaultBudgets, redisClient, appConfig.plans);

// ── Gmail OAuth connection flow ────────────────────────────────────────────
await connectionsOauthRoutes(app, db, appConfig, appConfig.plans);

// ── Agent-first platform routes ───────────────────────────────────────────
await agentRoutes(app, db, appConfig.plans, { db, providersYaml, context: makeCatalogContext(appConfig.llm) } satisfies LlmCatalogDeps, appConfig.agentRiskDefaults, appConfig.agentCostEstimates, redisClient, appConfig.agentRuntime.llm.modelDefaults);

// ── Advanced/secondary trading constructs ─────────────────────────────────
// These are retained as optional advanced paths. Step 21.3 will migrate
// venue_accounts to trading bindings and further reframe bots as internals.
await botRoutes(app, lifecycleQueue, db, redisClient, appConfig.plans, appConfig.agentRiskDefaults, tradertonBotClient);
await venueAccountRoutes(app, db, appConfig.plans, appConfig.venues);
await credentialRoutes(app, lifecycleQueue, db, appConfig.plans);
await journalRoutes(app, db);
await positionRoutes(app, db);
await reconciliationRoutes(app, db);
await backtestRoutes(app, backtestQueue, db, appConfig.plans);
await dashboardRoutes(app, db, appConfig.plans);

// ── Core platform services ─────────────────────────────────────────────────
// Billing routes — always registered; the summary endpoint is needed even when
// billing is disabled so the web UI can render the "not enabled" state.
await billingRoutes(app, appConfig.billing, appConfig.plans, db, appConfig.auth.frontendOrigin, appConfig.usageBilling, providersYaml);
await sessionRoutes(app, db);
await blueprintRoutes(app, db, appConfig.agentRiskDefaults, new BlueprintExecutionCapabilityAdapter(providersYaml), appConfig.plans);
await agentInteractivityRoutes(app, db, redisClient, appConfig.alerts, { db, providersYaml, context: makeCatalogContext(appConfig.llm) } satisfies LlmCatalogDeps, appConfig.plans, appConfig.agentRiskDefaults);
await analyticsRoutes(app, db);
await aiRoutes(app, db, appConfig.llm, redisClient, providersYaml, appConfig.agentRuntime);
const chatUsageBillingRepo = new UsageBillingRepository(db, appConfig.usageBilling?.defaultRateCardItems, providersYaml);
const chatUsageBillingRecorder = new ChatUsageBillingRecorder(
  chatUsageBillingRepo,
  appConfig.plans,
  appConfig.usageBilling?.defaultRateCardName ?? 'default',
);
await chatRoutes(app, db, appConfig.llm, providersYaml, redisClient, chatUsageBillingRepo, chatUsageBillingRecorder, appConfig.agentRuntime?.llm?.modelDefaults, appConfig.plans, appConfig.agentRiskDefaults, appConfig.venues);
await skillsRoutes(app, db, appConfig.plans, (() => {
  const ext = appConfig.externalSkills;
  if (!ext.enabled) return null;
  return new ExternalSkillProviderHttp({
    baseUrl: ext.apiBaseUrl,
    searchApiBaseUrl: ext.searchApiBaseUrl,
    searchTimeoutMs: ext.searchTimeoutMs,
    browseTimeoutMs: ext.browseTimeoutMs,
    statsTimeoutMs: ext.statsTimeoutMs,
  }, app.log);
})());
await datasetRoutes(app, db, redisClient);
await agentDocumentRoutes(app, db);
await exportRoutes(app, db);
await agentEvaluationRoutes(app, evaluationQueue, db, {
  storageRoot: appConfig.evaluation.storageRoot,
  maxRuntimeMs: appConfig.evaluation.maxRuntimeMs,
  maxAttempts: appConfig.evaluation.maxAttempts ?? 3,
}, {
  provider: appConfig.llm.provider,
  baseUrl: appConfig.llm.baseUrl,
  timeoutMs: appConfig.llm.timeoutMs,
  maxTokens: appConfig.llm.maxTokens,
  providersYaml,
  catalogTimeoutMs: appConfig.llm.catalog.timeoutMs,
  catalogCacheTtlMs: appConfig.llm.catalog.cacheTtlMs,
  openRouterProviderControls: appConfig.llm.openRouterProviderControls,
});
await platformAssessmentReviewRoutes(app, manualReviewQueue, db, {
  platformAssessorEnabled: appConfig.platformAssessor?.enabled ?? false,
});
await actorHealthRoutes(app, db, redisClient);
await adminRoutes(app, db, redisClient, { marketDataConfig: appConfig.marketData });

// ── Tool schema & discovery endpoints ─────────────────────────────────────
await toolSchemaRoutes(app);
await agentToolsRoutes(app);
await venueDefaultsRoutes(app, { defaultSlippageBps: appConfig.execution.defaultSlippageBps });
await strategySchemaRoutes(app);

// WebSocket event stream — uses a fresh Redis subscriber per connection.
// ioredis enters subscriber mode on the first subscribe call so each connection
// needs its own client instance.
await eventsRoutes(app, appConfig.auth, () => {
  const sub = new Redis(redisConnection);
  sub.on('error', (err: Error) => app.log.error({ err }, 'Events subscriber error'));
  return {
    subscribe: async (channel: string, callback: (msg: string) => void) => {
      sub.on('message', (_ch: string, message: string) => callback(message));
      await sub.subscribe(channel);
    },
    unsubscribe: async (channel: string) => {
      await sub.unsubscribe(channel);
      sub.disconnect();
    },
  };
});

const port = appConfig.app.port;

// ── Server health publisher ───────────────────────────────────────────────
serverHealthPublisher = new ServerHealthPublisher({
  redis: redisClient,
  serverType: 'control-plane',
  serverId: process.env['SERVER_ID'] ?? os.hostname(),
  version: parseAppVersion(),
  collectMetadata: async () => ({
    runningAgentSessions: await getRunningSessionCount(db),
    runningContainers: await getRunningContainerCount(),
    postgresStatus: await checkPostgres(db),
    redisStatus: await checkRedis(redisClient),
  }),
  logger: { warn: (obj, msg) => app.log.warn(obj, msg) },
});

app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`API server listening on port ${port}`);
  serverHealthPublisher.start();
});
