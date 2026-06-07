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
import { liveStatusRoutes } from './routes/live-status.js';
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
import { authPlugin } from './plugins/auth.js';
import { loadConfig } from './config.js';
import type { LifecycleJob, BacktestJob } from './types.js';

const appConfig = loadConfig();

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
await telegramWebhookHandler(app, appConfig.alerts);

// Auth routes (public — Google OAuth flow + exchange endpoint)
await authRoutes(app, appConfig.auth, db, redisClient, appConfig.plans.defaultPlanId);

// Register route modules (all require auth)
await botRoutes(app, lifecycleQueue, db, appConfig.plans);
await venueAccountRoutes(app, db, appConfig.plans);
await credentialRoutes(app, lifecycleQueue, db, appConfig.plans);
await journalRoutes(app, db);
await positionRoutes(app, db);
await reconciliationRoutes(app, db);
await backtestRoutes(app, backtestQueue, db, appConfig.plans);
await liveStatusRoutes(app, db);
await dashboardRoutes(app, db, appConfig.plans);
await agentRoutes(app, db, appConfig.plans);

// Billing routes — always registered; the summary endpoint is needed even when
// billing is disabled so the web UI can render the "not enabled" state.
await billingRoutes(app, appConfig.billing, appConfig.plans, db);
await sessionRoutes(app, db);
await blueprintRoutes(app, db);
await agentInteractivityRoutes(app, db, redisClient, appConfig.alerts);
await analyticsRoutes(app, db);
await aiRoutes(app, db, appConfig.llm, redisClient);
await skillsRoutes(app, db);
await datasetRoutes(app, db, redisClient);

const port = appConfig.app.port;

app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`API server listening on port ${port}`);
});
