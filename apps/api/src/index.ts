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
import type { LifecycleJob, BacktestJob } from './types.js';

const app = Fastify({ logger: true });

const redisConnection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
};

const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const db = createDatabase(databaseUrl);

const lifecycleQueue = new Queue<LifecycleJob>('trading-instance-lifecycle', {
  connection: redisConnection,
});

const backtestQueue = new Queue<BacktestJob>(BACKTEST_QUEUE_NAME, {
  connection: redisConnection,
});

// Health endpoint
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Register route modules
await instanceRoutes(app, lifecycleQueue, db);
await venueAccountRoutes(app, db);
await portfolioRoutes(app, db);
await credentialRoutes(app, lifecycleQueue, db);
await journalRoutes(app, db);
await positionRoutes(app, db);
await portfolioPositionRoutes(app, db);
await reconciliationRoutes(app, db);
await backtestRoutes(app, backtestQueue, db);
await liveStatusRoutes(app, db);

const port = parseInt(process.env['PORT'] ?? '3000', 10);

app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`API server listening on port ${port}`);
});
