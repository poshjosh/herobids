import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDatabase } from '@herobids/db';
import { botRoutes } from './routes/bots.js';
import { venueAccountRoutes } from './routes/accounts.js';
import { credentialRoutes } from './routes/credentials.js';
import { journalRoutes, positionRoutes } from './routes/views.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { backtestRoutes, BACKTEST_QUEUE_NAME } from './routes/backtests.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { billingRoutes } from './routes/billing.js';
import { agentRoutes } from './routes/agents.js';
import { sessionRoutes } from './routes/sessions.js';
import { blueprintRoutes } from './routes/blueprints.js';
import { agentInteractivityRoutes, telegramWebhookHandler } from './routes/agent-interactivity.js';
import { analyticsRoutes } from './routes/analytics.js';
import { aiRoutes } from './routes/ai.js';
import { skillsRoutes } from './routes/skills.js';
import { datasetRoutes } from './routes/datasets.js';
import { exportRoutes } from './routes/exports.js';
import { actorHealthRoutes } from './routes/actor-health.js';
import { adminRoutes } from './routes/admin.js';
import { eventsRoutes } from './routes/events.js';
import { toolSchemaRoutes } from './routes/tool-schemas.js';
import { agentToolsRoutes } from './routes/agent-tools.js';
import { venueDefaultsRoutes } from './routes/venue-defaults.js';
import { strategySchemaRoutes } from './routes/strategy-schemas.js';
import { loadProvidersConfig } from '@herobids/domain';
import { makeCatalogContext, type LlmCatalogDeps } from './llm-model-catalog.js';
import { connectionRoutes } from './routes/connections.js';
import { capabilityRoutes } from './routes/capabilities/index.js';
import { setupRoutes } from './routes/setup.js';
import { providerRoutes } from './routes/providers.js';
import { authPlugin } from './plugins/auth.js';
import { loadConfig } from './config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LifecycleJob, BacktestJob } from './types.js';
import { syncSystemSkills } from './sync-system-skills.js';

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

process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.error('[FATAL] SIGTERM received — the process will exit.');
  process.exit(0);
});

process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.error('[FATAL] SIGINT received — the process will exit.');
  process.exit(0);
});

const appConfig = loadConfig();

// Load the provider registry (providers.yaml) for LLM catalog functions.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MONOREPO_CONFIG_DIR = resolve(MODULE_DIR, '../../../config');
const providersYaml = loadProvidersConfig(resolve(MONOREPO_CONFIG_DIR, 'providers.yaml'));

const isPrettyLog = process.env['LOG_FORMAT'] === 'pretty' || process.env['NODE_ENV'] === 'development';
const app = Fastify({
  logger: isPrettyLog
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : true,
});

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

const backtestQueue = new Queue<BacktestJob>(BACKTEST_QUEUE_NAME, {
  connection: redisConnection,
});

// Register auth plugin (JWT verification on all non-public routes)
await authPlugin(app, { config: appConfig.auth, db });

// CORS — allow the configured frontend origin to make credentialed requests
await app.register(cors, {
  origin: [appConfig.auth.frontendOrigin],
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// Health endpoint (public — no auth required)
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Telegram webhook — public (unauthenticated), token-validated
await telegramWebhookHandler(app, db, redisClient, appConfig.alerts);

// Auth routes (public — Google OAuth flow + exchange endpoint)
await authRoutes(app, appConfig.auth, db, redisClient, appConfig.plans.defaultPlanId, appConfig.plans);

// ── Capability routes (primary public surface) ────────────────────────────
await capabilityRoutes(app, db, appConfig.plans, appConfig.agentRuntime.defaultBudgets, redisClient);

// ── Setup flows (guided orchestration over primitives) ────────────────────────
await setupRoutes(app, db, appConfig.plans);
await providerRoutes(app);

// ── Platform primitives ───────────────────────────────────────────────────
await connectionRoutes(app, db, appConfig.agentRuntime.defaultBudgets, redisClient, appConfig.plans);

// ── Agent-first platform routes ───────────────────────────────────────────
await agentRoutes(app, db, appConfig.plans, { db, providersYaml, context: makeCatalogContext(appConfig.llm) } satisfies LlmCatalogDeps, appConfig.agentRiskDefaults, appConfig.agentCostEstimates, redisClient);

// ── Advanced/secondary trading constructs ─────────────────────────────────
// These are retained as optional advanced paths. Step 21.3 will migrate
// venue_accounts to trading bindings and further reframe bots as internals.
await botRoutes(app, lifecycleQueue, db, appConfig.plans);
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
await billingRoutes(app, appConfig.billing, appConfig.plans, db, appConfig.usageBilling);
await sessionRoutes(app, db);
await blueprintRoutes(app, db);
await agentInteractivityRoutes(app, db, redisClient, appConfig.alerts, { db, providersYaml, context: makeCatalogContext(appConfig.llm) } satisfies LlmCatalogDeps, appConfig.plans);
await analyticsRoutes(app, db);
await aiRoutes(app, db, appConfig.llm, redisClient, providersYaml);
await skillsRoutes(app, db, appConfig.plans);
await datasetRoutes(app, db, redisClient);
await exportRoutes(app, db);
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

app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`API server listening on port ${port}`);
});
