import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { createDatabase } from '@herobids/db';
import { instanceRoutes } from './routes/instances.js';
import { venueAccountRoutes, portfolioRoutes } from './routes/accounts.js';
import { credentialRoutes } from './routes/credentials.js';
import { journalRoutes, positionRoutes, portfolioPositionRoutes } from './routes/views.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { backtestRoutes, BACKTEST_QUEUE_NAME } from './routes/backtests.js';
import { liveStatusRoutes } from './routes/live-status.js';
import { authRoutes } from './routes/auth.js';
import { authPlugin } from './plugins/auth.js';
import { loadConfig } from './config.js';
import type { LifecycleJob, BacktestJob } from './types.js';

const appConfig = loadConfig();

const app = Fastify({ logger: true });

const parsedRedisUrl = new URL(appConfig.redis.url);
const redisConnection = {
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.username && { username: decodeURIComponent(parsedRedisUrl.username) }),
  ...(parsedRedisUrl.pathname && parsedRedisUrl.pathname !== '/' && { db: parseInt(parsedRedisUrl.pathname.slice(1), 10) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
};

const db = createDatabase(appConfig.database.url);

const lifecycleQueue = new Queue<LifecycleJob>('trading-instance-lifecycle', {
  connection: redisConnection,
});

const backtestQueue = new Queue<BacktestJob>(BACKTEST_QUEUE_NAME, {
  connection: redisConnection,
});

// Register auth plugin (JWT verification on all non-public routes)
await authPlugin(app, { config: appConfig.auth, db });

// Health endpoint (public — no auth required)
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Auth routes (public — Google OAuth flow)
await authRoutes(app, appConfig.auth, db, appConfig.plans.defaultPlanId);

// Register route modules (all require auth)
await instanceRoutes(app, lifecycleQueue, db, appConfig.plans);
await venueAccountRoutes(app, db, appConfig.plans);
await portfolioRoutes(app, db, appConfig.plans);
await credentialRoutes(app, lifecycleQueue, db, appConfig.plans);
await journalRoutes(app, db);
await positionRoutes(app, db);
await portfolioPositionRoutes(app, db);
await reconciliationRoutes(app, db);
await backtestRoutes(app, backtestQueue, db, appConfig.plans);
await liveStatusRoutes(app, db);

const port = appConfig.app.port;

app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`API server listening on port ${port}`);
});
