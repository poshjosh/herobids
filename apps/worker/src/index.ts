import pino from 'pino';
import Redis from 'ioredis';
import { WorkerRuntime, QUEUE_NAME } from './runtime.js';
import type { PersistedInstance } from './runtime.js';
import { InstanceLease } from './instance-lease.js';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { MomentumStrategy } from '@herobids/strategy';
import { createDatabase, PgJournal, FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, ReconciliationEventRepository, tradingInstances, venueAccounts, credentials } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { HyperliquidAdapter, JupiterSwapAdapter } from '@herobids/venues';
import type { IdGenerator } from '@herobids/engine';
import { quantity, price, TradingInstanceConfigSchema, ReconciliationConfigSchema } from '@herobids/domain';
import type { MarketSnapshot, OrderId, FillId } from '@herobids/domain';
import crypto from 'node:crypto';
import { decryptCredential } from './crypto.js';

class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

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
const orderRepo = new OrderRepository(db);
const balanceSnapshotRepo = new BalanceSnapshotRepository(db);
const reconciliationRepo = new ReconciliationEventRepository(db);

// Parse reconciliation config from environment/config file
const reconciliationConfig = ReconciliationConfigSchema.parse({
  intervalMs: parseInt(process.env['RECONCILIATION_INTERVAL_MS'] ?? '30000', 10),
  driftAlertOnly: (process.env['RECONCILIATION_DRIFT_ALERT_ONLY'] ?? 'true') === 'true',
  positionDriftThreshold: process.env['RECONCILIATION_POSITION_THRESHOLD'] ?? '0',
  balanceDriftThreshold: process.env['RECONCILIATION_BALANCE_THRESHOLD'] ?? '0',
  autoCorrect: (process.env['RECONCILIATION_AUTO_CORRECT'] ?? 'false') === 'true',
});

// ID generator using UUIDv7 (crypto.randomUUID as fallback)
const idGen: IdGenerator & { planId(): string; decisionId(): string } = {
  orderId: () => crypto.randomUUID() as OrderId,
  fillId: () => crypto.randomUUID() as FillId,
  planId: () => crypto.randomUUID(),
  decisionId: () => crypto.randomUUID(),
};

const runtime = new WorkerRuntime(
  { redis: redisConnection, scanIntervalMs: 5000, concurrency: 10 },
  async (tradingInstanceId, rawConfig) => {
    // Validate instance config
    const parseResult = TradingInstanceConfigSchema.safeParse(rawConfig);
    const config = parseResult.success ? parseResult.data : {
      strategy: { type: 'momentum' as const, params: {} },
      risk: {
        maxPositionSize: undefined as string | undefined,
        maxOpenPositions: undefined as number | undefined,
        maxDrawdown: undefined as string | undefined,
        maxPositionSizePct: undefined as number | undefined,
        dailyMaxLossPct: undefined as number | undefined,
        stopLossCooldownMs: undefined as number | undefined,
        maxOrderNotional: undefined as string | undefined,
      },
      execution: { mode: 'paper' as const },
      venue: (rawConfig['venue'] as string) ?? 'hyperliquid',
      symbol: (rawConfig['symbol'] as string) ?? 'BTC/USD:USD',
      venueType: 'orderbook' as const,
      shadowPollIntervalMs: 2000,
    };

    const strategy = new MomentumStrategy(() => idGen.decisionId());

    // Resolve credentials: try DB lookup via venueAccountId, fall back to process env
    const venueAccountId = (rawConfig['venueAccountId'] as string) ?? rawConfig['venue_account_id'] as string ?? 'default';
    let apiKey = process.env['HYPERLIQUID_API_KEY'] ?? '';
    let secret = process.env['HYPERLIQUID_SECRET'] ?? '';
    let testnet = true;

    if (venueAccountId !== 'default') {
      try {
        const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
        if (account?.credentialId) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, account.credentialId)).limit(1);
          if (cred) {
            const encryptionKey = process.env['CREDENTIAL_ENCRYPTION_KEY'];
            if (encryptionKey) {
              const decrypted = JSON.parse(decryptCredential(cred.encryptedData, encryptionKey)) as { apiKey: string; secret: string; testnet?: boolean };
              apiKey = decrypted.apiKey;
              secret = decrypted.secret;
              testnet = decrypted.testnet ?? false;
            } else {
              throw new CredentialResolutionError(`CREDENTIAL_ENCRYPTION_KEY not set — cannot decrypt credentials for venueAccount ${venueAccountId}`);
            }
          } else {
            throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
          }
        } else {
          throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
        }
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        throw new CredentialResolutionError(`Failed to load credentials for venueAccount ${venueAccountId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Stream config (shared between adapter construction and actor deps)
    const streamConfig = {
      reconnectBaseMs: parseInt(process.env['STREAM_RECONNECT_BASE_MS'] ?? '1000', 10),
      reconnectMaxMs: parseInt(process.env['STREAM_RECONNECT_MAX_MS'] ?? '30000', 10),
      maxReconnectAttempts: parseInt(process.env['STREAM_MAX_RECONNECT_ATTEMPTS'] ?? '10', 10),
    };

    // Construct venue adapters based on venueType
    const venueAdapter = config.venueType !== 'swap'
      ? new HyperliquidAdapter({
          credentials: { apiKey, secret, testnet },
          streamConfig,
        })
      : undefined;

    // Construct swap venue adapter when venueType is 'swap'
    const swapVenue = config.venueType === 'swap'
      ? new JupiterSwapAdapter({
          walletAddress: process.env['SWAP_WALLET_ADDRESS'] ?? apiKey,
          apiUrl: process.env['JUPITER_API_URL'] ?? 'https://quote-api.jup.ag/v6',
          rpcUrl: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
        })
      : undefined;

    const fetchPrice = async (): Promise<MarketSnapshot | null> => {
      if (!venueAdapter) return null; // Swap venues don't use orderbook ticker
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
      orderRepo,
      balanceSnapshotRepo,
      reconciliationRepo,
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
      venuePort: venueAdapter ?? undefined,
      reconciliationConfig,
      executionMode: config.execution.mode,
      streamConfig,
      venue: config.venue,
      symbol: config.symbol,
      venueAccountId,
      venueType: config.venueType,
      swapVenue,
      shadowPollIntervalMs: config.shadowPollIntervalMs,
      onCrashed: async (instanceId: string) => {
        await db.update(tradingInstances)
          .set({ status: 'crashed', stoppedAt: new Date() })
          .where(eq(tradingInstances.id, instanceId));
        // Remove from runtime map and release lease
        await runtime.handleActorCrash(instanceId);
        logger.error({ tradingInstanceId: instanceId }, 'Instance marked as crashed in DB');
      },
    };
    return new TradingActor(tradingInstanceId, rawConfig, deps);
  },
  // Instance loader for crash recovery — loads all 'running' instances from DB
  async (): Promise<PersistedInstance[]> => {
    const running = await db.select().from(tradingInstances).where(eq(tradingInstances.status, 'running'));
    return running.map((row) => ({
      id: row.id,
      config: { ...row.config, venueAccountId: row.venueAccountId },
    }));
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
