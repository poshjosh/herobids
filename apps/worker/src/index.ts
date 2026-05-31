import pino from 'pino';
import Redis from 'ioredis';
import { WorkerRuntime, QUEUE_NAME } from './runtime.js';
import type { PersistedInstance } from './runtime.js';
import { BacktestRuntime } from './backtest-runtime.js';
import { InstanceLease } from './instance-lease.js';
import { TradingActor } from './trading-actor.js';
import type { TradingActorDeps } from './trading-actor.js';
import { MomentumStrategy, LlmStrategy } from '@herobids/strategy';
import { MarketDataRecorder } from '@herobids/backtesting';
import { createDatabase, PgJournal, FillRepository, PositionRepository, ExecutionPlanRepository, OrderRepository, BalanceSnapshotRepository, ReconciliationEventRepository, DecisionRepository, BacktestingRepository, tradingInstances, venueAccounts, credentials } from '@herobids/db';
import { eq } from 'drizzle-orm';
import { HyperliquidAdapter, BybitAdapter, JupiterSwapAdapter, PublicStreamPool, HyperliquidPublicStream, BybitPublicStream, OracleMarkSource } from '@herobids/venues';
import type { IdGenerator } from '@herobids/engine';
import { LastFillMarkSource, MarkSelector, credentialDecryptedEvent } from '@herobids/engine';
import { quantity, price, TradingInstanceConfigSchema } from '@herobids/domain';
import type { MarketSnapshot, OrderId, FillId, Strategy, StrategyConfig } from '@herobids/domain';
import crypto from 'node:crypto';
import { decryptCredential } from './crypto.js';
import { loadConfig } from './config.js';
import { assertLiveReadiness, LiveGateError } from './live-gate.js';

class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialResolutionError';
  }
}

const logger = pino({ name: 'herobids-worker' });

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
const hyperliquidVenueConfig = appConfig.venues['hyperliquid'];
const bybitVenueConfig = appConfig.venues['bybit'];

const streamConnectors = new Map<string, () => import('@herobids/venues').VenueStreamConnector>();
if (hyperliquidVenueConfig?.wsUrl) {
  streamConnectors.set('hyperliquid', () => new HyperliquidPublicStream({
    wsUrl: hyperliquidVenueConfig.wsUrl!,
  }));
}
if (bybitVenueConfig?.wsPublicUrl || bybitVenueConfig?.wsUrl) {
  streamConnectors.set('bybit', () => new BybitPublicStream({
    wsUrl: bybitVenueConfig.wsPublicUrl ?? 'wss://stream.bybit.com/v5/public/linear',
  }));
}

const publicStreamPool = streamConnectors.size > 0
  ? new PublicStreamPool(publicStreamConfig, streamConnectors)
  : undefined;

// Worker-scoped oracle mark source (stateless, safe to share)
const oracleMarkSource = new OracleMarkSource({
  baseUrl: appConfig.marking.oracleBaseUrl ?? 'https://api.coingecko.com/api/v3',
  instrumentToCoinId: appConfig.marking.instrumentToCoinId ?? {},
});

const runtime = new WorkerRuntime(
  {
    redis: redisConnection,
    scanIntervalMs: 5000,
    concurrency: 10,
    onStartFailed: async (tradingInstanceId, error) => {
      logger.error(
        {
          tradingInstanceId,
          err: error.message,
          ...(error instanceof LiveGateError && { code: error.code }),
        },
        'Instance start failed — marking crashed'
      );
      await db.update(tradingInstances)
        .set({ status: 'crashed', stoppedAt: new Date(), updatedAt: new Date() })
        .where(eq(tradingInstances.id, tradingInstanceId));
    },
  },
  async (tradingInstanceId, rawConfig) => {
    // Validate instance config — fail fast on invalid config
    const parseResult = TradingInstanceConfigSchema.safeParse(rawConfig);
    if (!parseResult.success) {
      throw new Error(
        `Invalid config for instance ${tradingInstanceId}: ${parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const config = parseResult.data;

    const strategy = createStrategy(config.strategy);

    // Resolve credentials: try DB lookup via venueAccountId, fall back to venue-specific env vars
    const venueAccountId = (rawConfig['venueAccountId'] as string) ?? rawConfig['venue_account_id'] as string ?? 'default';
    let apiKey = config.venue === 'bybit'
      ? process.env['BYBIT_API_KEY'] ?? ''
      : process.env['HYPERLIQUID_API_KEY'] ?? '';
    let secret = config.venue === 'bybit'
      ? process.env['BYBIT_SECRET'] ?? ''
      : process.env['HYPERLIQUID_SECRET'] ?? '';
    let walletAddress = process.env['HYPERLIQUID_ACCOUNT_ADDRESS'] ?? '';
    let testnet = true;
    let credentialsFromDb = false;
    let resolvedCredentialId: string | undefined;

    // Credential resolution is only needed for orderbook venues (exchange API keys).
    // Swap venues are wallet-only — they resolve their address from venueAccountRef later.
    if (venueAccountId !== 'default' && config.venueType !== 'swap') {
      let pendingCredentialId: string | undefined;
      try {
        const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
        if (account?.credentialId) {
          pendingCredentialId = account.credentialId;
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, account.credentialId)).limit(1);
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
                tradingInstanceId,
                outcome: 'success',
              })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            } else {
              journal.append(credentialDecryptedEvent({
                credentialId: account.credentialId,
                venue: config.venue,
                venueAccountId,
                tradingInstanceId,
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
              tradingInstanceId,
              outcome: 'failure',
              error: 'Credential record not found (dangling reference)',
            })).catch((err) => { logger.error({ err, credentialId: account.credentialId, venueAccountId, eventType: 'credential.decrypted' }, 'Failed to persist credential audit event'); });
            throw new CredentialResolutionError(`Credential record not found for venueAccount ${venueAccountId}`);
          }
        } else {
          throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
        }
      } catch (err) {
        if (err instanceof CredentialResolutionError) throw err;
        // Decrypt or parse failed — emit failure audit before re-throwing
        if (pendingCredentialId) {
          journal.append(credentialDecryptedEvent({
            credentialId: pendingCredentialId,
            venue: config.venue,
            venueAccountId,
            tradingInstanceId,
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
            streamConfig,
          })
        : new HyperliquidAdapter({
            credentials: { apiKey, secret, walletAddress, testnet },
            streamConfig,
          })
      : undefined;

    // Construct swap venue adapter when venueType is 'swap'
    const swapVenue = config.venueType === 'swap'
      ? await (async () => {
          // swapAssets is required for swap venues — fail fast if missing
          if (!config.swapAssets) {
            throw new CredentialResolutionError(
              `swapAssets config required for swap venue instance ${tradingInstanceId} — cannot route swaps without explicit asset identifiers and decimals`,
            );
          }
          // Resolve wallet from venue account record; fall back to env var only for the 'default' account
          let walletAddress: string | undefined;
          if (venueAccountId !== 'default') {
            const [account] = await db.select().from(venueAccounts).where(eq(venueAccounts.id, venueAccountId)).limit(1);
            if (!account?.venueAccountRef) {
              throw new CredentialResolutionError(
                `Venue account ${venueAccountId} has no venueAccountRef — cannot resolve wallet address for swap venue instance ${tradingInstanceId}`,
              );
            }
            walletAddress = account.venueAccountRef;
          } else {
            walletAddress = process.env['SWAP_WALLET_ADDRESS'];
          }
          if (!walletAddress) {
            throw new CredentialResolutionError(
              `Wallet address required for swap venue instance ${tradingInstanceId}. Set venueAccountRef on the venue account or SWAP_WALLET_ADDRESS env var.`,
            );
          }
          // Build token decimals map from configured swap assets
          const tokenDecimals: Record<string, number> = {
            [config.swapAssets.baseAsset]: config.swapAssets.baseDecimals,
            [config.swapAssets.quoteAsset]: config.swapAssets.quoteDecimals,
          };
          return new JupiterSwapAdapter({
            walletAddress,
            apiUrl: appConfig.venues['jupiter']?.baseUrl ?? 'https://quote-api.jup.ag/v6',
            rpcUrl: process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
            tokenDecimals,
            timeoutMs: appConfig.venues['jupiter']?.timeoutMs,
          });
        })()
      : undefined;

    const fetchPrice = async (): Promise<MarketSnapshot | null> => {
      if (!venueAdapter) return null; // Swap venues don't use orderbook ticker
      const result = await venueAdapter.fetchTicker(config.symbol);
      if (!result.ok) {
        logger.warn({ tradingInstanceId, symbol: config.symbol, error: result.error }, 'fetchTicker failed');
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
        name: `${tradingInstanceId}-${new Date().toISOString()}`,
        source: 'live-recording',
        venue: config.venue,
        symbols: [config.symbol],
        metadata: {
          tradingInstanceId,
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
      venuePort: venueAdapter ?? undefined,
      reconciliationConfig,
      executionMode: config.execution.mode,
      streamConfig,
      venue: config.venue,
      symbol: config.symbol,
      venueAccountId,
      venueType: config.venueType,
      swapAssets: config.swapAssets,
      swapVenue,
      streamPool: config.venueType !== 'swap' ? publicStreamPool : undefined,
      markSource: new MarkSelector(
        { stalenessThresholdMs: appConfig.marking.stalenessThresholdMs },
        new LastFillMarkSource(fillRepo, tradingInstanceId),
        oracleMarkSource,
      ),
      recordMarketSnapshot,
      recordReferenceMark,
      shadowPollIntervalMs: config.shadowPollIntervalMs,
      credentialId: resolvedCredentialId,
      onCrashed: async (instanceId: string) => {
        await db.update(tradingInstances)
          .set({ status: 'crashed', stoppedAt: new Date() })
          .where(eq(tradingInstances.id, instanceId));
        // Remove from runtime map and release lease
        await runtime.handleActorCrash(instanceId);
        logger.error({ tradingInstanceId: instanceId }, 'Instance marked as crashed in DB');
      },
    };
    return new TradingActor(tradingInstanceId, config.strategy.params as Record<string, unknown>, deps);
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
  await backtestRuntime.stop();
  await runtime.shutdown();
  await publicStreamPool?.shutdown();
  await redisClient.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  await backtestRuntime.stop();
  await runtime.shutdown();
  await publicStreamPool?.shutdown();
  await redisClient.quit();
  process.exit(0);
});

// Start backtest runtime (BullMQ consumer for bounded backtest jobs)
const backtestRuntime = new BacktestRuntime(
  {
    redis: redisConnection,
    concurrency: 2,
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

await runtime.start();
logger.info({ workerId, queue: QUEUE_NAME }, 'Worker process started');
