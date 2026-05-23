import pino from 'pino';
import Redis from 'ioredis';
import { WorkerRuntime, QUEUE_NAME } from './runtime.js';
import type { PersistedInstance } from './runtime.js';
import { InstanceLease } from './instance-lease.js';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { MomentumStrategy } from '@herobids/strategy';
import { createDatabase, PgJournal, FillRepository, PositionRepository, ExecutionPlanRepository, tradingInstances } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { HyperliquidAdapter } from '@herobids/venues';
import type { IdGenerator } from '@herobids/engine';
import { quantity, price, TradingInstanceConfigSchema } from '@herobids/domain';
import type { MarketSnapshot, OrderId, FillId } from '@herobids/domain';
import crypto from 'node:crypto';

const logger = pino({ name: 'herobids-worker' });

const redisConnection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
};

// Redis client for lease management (separate from BullMQ's internal connection)
const redisClient = new Redis(redisConnection.port, redisConnection.host);
const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
const lease = new InstanceLease(redisClient, workerId, 30);

const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
const db = createDatabase(databaseUrl);
const journal = new PgJournal(db);
const fillRepo = new FillRepository(db);
const positionRepo = new PositionRepository(db);
const planRepo = new ExecutionPlanRepository(db);

// ID generator using UUIDv7 (crypto.randomUUID as fallback)
const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
  orderId: () => crypto.randomUUID() as OrderId,
  fillId: () => crypto.randomUUID() as FillId,
  planId: () => crypto.randomUUID(),
  decisionId: () => crypto.randomUUID(),
};

const runtime = new WorkerRuntime(
  { redis: redisConnection, scanIntervalMs: 5000, concurrency: 10 },
  (tradingInstanceId, rawConfig) => {
    // Validate instance config
    const parseResult = TradingInstanceConfigSchema.safeParse(rawConfig);
    const config = parseResult.success ? parseResult.data : {
      strategy: { type: 'momentum', params: {} },
      risk: {},
      execution: { mode: 'paper' as const },
      venue: (rawConfig['venue'] as string) ?? 'hyperliquid',
      symbol: (rawConfig['symbol'] as string) ?? 'BTC/USD:USD',
    };

    const strategy = new MomentumStrategy(() => idGen.decisionId());

    // Create venue adapter for market data (demo mode — no real credentials needed for fetchTicker)
    const venueAdapter = new HyperliquidAdapter({
      credentials: {
        apiKey: process.env['HYPERLIQUID_API_KEY'] ?? '',
        secret: process.env['HYPERLIQUID_SECRET'] ?? '',
        testnet: true,
      },
    });

    const fetchPrice = async (): Promise<MarketSnapshot | null> => {
      const result = await venueAdapter.fetchTicker(config.symbol);
      if (!result.ok) return null;
      return {
        symbol: config.symbol,
        price: result.data.last,
        timestamp: result.data.timestamp,
      };
    };

    const deps: TradingActorDeps = {
      strategy,
      journal,
      fillRepo,
      positionRepo,
      planRepo,
      riskLimits: {
        maxPositionSize: quantity(String(config.risk.maxPositionSize ?? '100')),
        maxOpenPositions: config.risk.maxOpenPositions ?? 5,
        maxDrawdown: price(String(config.risk.maxDrawdown ?? '10000')),
        maxPositionSizePct: config.risk.maxPositionSizePct,
        dailyMaxLossPct: config.risk.dailyMaxLossPct,
        stopLossCooldownMs: config.risk.stopLossCooldownMs,
      },
      idGen,
      fetchPrice,
      venue: config.venue,
      symbol: config.symbol,
      venueAccountId: (rawConfig['venueAccountId'] as string) ?? 'default',
    };
    return new TradingActor(tradingInstanceId, rawConfig, deps);
  },
  // Instance loader for crash recovery — loads all 'running' instances from DB
  async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(tradingInstances).where(eq(tradingInstances.status, 'running'));
    return running.map((row) => ({ id: row.id, config: row.config }));
  },
  lease,
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await runtime.shutdown();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await runtime.shutdown();
  await redisClient.quit();
  process.exit(0);
});

await runtime.start();
logger.info({ workerId, queue: QUEUE_NAME }, 'Worker process started');
