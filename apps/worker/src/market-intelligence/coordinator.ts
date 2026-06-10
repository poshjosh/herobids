import type { Redis } from 'ioredis';
import pino from 'pino';
import crypto from 'node:crypto';
import { createLeaderElection, type LeaderElection } from './leader-election.js';
import type { ProviderRegistry } from '@herobids/market-data';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import type { MarketMonitor } from './monitor.js';

const logger = pino({ name: 'market-data-coordinator' });

export interface CoordinatorConfig {
  workerId: string;
  /** Discovery poll interval in ms. Default: 30000 */
  discoveryPollMs?: number;
  /** Regime poll interval in ms. Default: 60000 */
  regimePollMs?: number;
  /** Maximum allowed discovery snapshot age in ms. Default: 600000 (10 min) */
  discoveryMaxAgeMs?: number;
  /** Networks to run discovery for. Default: ['solana'] */
  networks?: string[];
  /** Benchmark symbols for regime monitoring. Default: ['BTC'] */
  benchmarkSymbols?: string[];
  /** Enable/disable the coordinator. Default: true */
  enabled?: boolean;
}

export interface CoordinatorDeps {
  redis: Redis;
  providerRegistry: ProviderRegistry;
  publisher: InstanceEventPublisher;
  /** Optional monitor — started/stopped with this coordinator under the same leader lease. */
  monitor?: MarketMonitor;
}

export interface MarketDataCoordinator {
  start(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
}

export function createMarketDataCoordinator(
  config: CoordinatorConfig,
  deps: CoordinatorDeps,
): MarketDataCoordinator {
  const {
    discoveryPollMs = 30_000,
    regimePollMs = 60_000,
    discoveryMaxAgeMs = 600_000,
    networks = ['solana'],
    benchmarkSymbols = ['BTC'],
    enabled = true,
  } = config;

  const { redis, providerRegistry } = deps;

  let leaderElection: LeaderElection | undefined;
  let discoveryTimer: ReturnType<typeof setInterval> | undefined;
  let regimeTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  function start(): void {
    if (!enabled) {
      logger.info('Market data coordinator disabled');
      return;
    }
    stopped = false;
    leaderElection = createLeaderElection(redis, { workerId: config.workerId });
    leaderElection.start(onLeaderAcquired, onLeaderLost);
  }

  function onLeaderAcquired(): void {
    logger.info('Starting coordinator loops');
    startDiscoveryLoop();
    startRegimeLoop();
    deps.monitor?.start();
  }

  function onLeaderLost(): void {
    logger.warn('Stopping coordinator loops — leadership lost');
    stopLoops();
    deps.monitor?.stop();
  }

  function startDiscoveryLoop(): void {
    clearInterval(discoveryTimer);
    // Run immediately then on interval
    void refreshDiscovery();
    discoveryTimer = setInterval(() => {
      if (stopped) return;
      void refreshDiscovery();
    }, discoveryPollMs);
  }

  function startRegimeLoop(): void {
    clearInterval(regimeTimer);
    void refreshRegime();
    regimeTimer = setInterval(() => {
      if (stopped) return;
      void refreshRegime();
    }, regimePollMs);
  }

  function stopLoops(): void {
    clearInterval(discoveryTimer);
    clearInterval(regimeTimer);
  }

  function countTokensByNetwork(tokens: Array<{ network: string }>): Record<string, number> {
    const networkCounts: Record<string, number> = {};
    for (const token of tokens) {
      networkCounts[token.network] = (networkCounts[token.network] ?? 0) + 1;
    }
    return networkCounts;
  }

  function getElapsedAgeMs(capturedAt: string): number {
    const capturedAtMs = Date.parse(capturedAt);
    if (!Number.isFinite(capturedAtMs)) {
      return 0;
    }

    return Math.max(0, Date.now() - capturedAtMs);
  }

  async function writeDiscoveryState(
    snapshot: {
      snapshotId: string;
      capturedAt: string;
      freshness: { state: 'fresh' | 'stale' | 'unavailable'; ageMs: number; maxAllowedAgeMs: number };
      sources: Record<string, unknown>;
      tokens: Array<{
        network: string;
        address: string;
        symbol: string;
        name?: string | null;
        priceUsd?: number | null;
        liquidityUsd?: number | null;
        volume24hUsd?: number | null;
        poolAddress?: string | null;
        poolCreatedAt?: string | null;
        discoveryVectors?: string[];
        rank?: number;
      }>;
    },
  ): Promise<void> {
    const networkCounts = countTokensByNetwork(snapshot.tokens);
    const sourceStats = Object.fromEntries(
      Object.entries(snapshot.sources).map(([sourceName, value]) => {
        const sourceRecord = value as Record<string, unknown>;
        return [sourceName, {
          ok: sourceRecord['ok'] ?? false,
          freshness: sourceRecord['freshness'] ?? snapshot.freshness.state,
          tokenCount: snapshot.tokens.length,
          networkCounts,
        }];
      }),
    );

    const meta = {
      snapshotId: snapshot.snapshotId,
      leaderWorkerId: config.workerId,
      capturedAt: snapshot.capturedAt,
      networks,
      tokenCount: snapshot.tokens.length,
      pollIntervalMs: discoveryPollMs,
      nextPollDueAt: new Date(Date.now() + discoveryPollMs).toISOString(),
      sourceStats,
    };

    const pipeline = redis.pipeline();
    pipeline.set('market-intel:discovery:latest', JSON.stringify(snapshot), 'PX', discoveryMaxAgeMs);
    pipeline.set('market-intel:discovery:meta', JSON.stringify(meta), 'PX', discoveryMaxAgeMs);

    for (const network of networks) {
      const networkTokens = snapshot.tokens.filter((token) => token.network === network);
      const networkSlice = {
        snapshotId: snapshot.snapshotId,
        capturedAt: snapshot.capturedAt,
        network,
        freshness: snapshot.freshness,
        sources: snapshot.sources,
        tokens: networkTokens,
      };
      pipeline.set(
        `market-intel:discovery:by-network:${network}`,
        JSON.stringify(networkSlice),
        'PX',
        discoveryMaxAgeMs,
      );
    }

    await pipeline.exec();
  }

  async function refreshDiscovery(): Promise<void> {
    const snapshotId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();

    try {
      const result = await providerRegistry.discovery.discover({ networks, maxResults: 25 });
      if (stopped) return;
      const tokens = result.data ?? [];

      const snapshot = {
        snapshotId,
        capturedAt,
        freshness: {
          state: 'fresh' as const,
          ageMs: 0,
          maxAllowedAgeMs: discoveryMaxAgeMs,
        },
        sources: {
          discovery: { ok: true, freshness: 'fresh' },
        },
        tokens: tokens.map((token, idx) => ({
          network: token.network,
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          priceUsd: token.priceUsd,
          liquidityUsd: token.liquidityUsd,
          volume24hUsd: token.volume24hUsd,
          poolAddress: token.poolAddress ?? null,
          poolCreatedAt: token.poolCreatedAt ?? null,
          discoveryVectors: token.discoveryVectors,
          rank: idx + 1,
        })),
      };

      await writeDiscoveryState(snapshot);
      if (stopped) return;

      logger.debug({ snapshotId, tokenCount: tokens.length }, 'Discovery snapshot refreshed');
    } catch (err) {
      if (stopped) return;
      logger.error({ err }, 'Discovery refresh failed — marking stale');
      await markDiscoveryStale(snapshotId, capturedAt);
    }
  }

  async function markDiscoveryStale(snapshotId: string, capturedAt: string): Promise<void> {
    if (stopped) return;
    const existingRaw = await redis.get('market-intel:discovery:latest');
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as Record<string, unknown>;
        const freshness = existing['freshness'] as Record<string, unknown> | undefined;
        if (freshness) {
          if (stopped) return;
          freshness['state'] = 'stale';
          // Update source health to reflect failure
          const sources = (existing['sources'] ?? {}) as Record<string, unknown>;
          sources['discovery'] = { ok: false, freshness: 'stale' };
          existing['sources'] = sources;
          const staleCapturedAt = String(existing['capturedAt'] ?? capturedAt);
          await writeDiscoveryState({
            snapshotId: String(existing['snapshotId'] ?? snapshotId),
            capturedAt: staleCapturedAt,
            freshness: {
              state: 'stale',
              ageMs: getElapsedAgeMs(staleCapturedAt),
              maxAllowedAgeMs: Number(freshness['maxAllowedAgeMs'] ?? discoveryMaxAgeMs),
            },
            sources,
            tokens: Array.isArray(existing['tokens']) ? existing['tokens'] as Array<{
              network: string;
              address: string;
              symbol: string;
              name?: string | null;
              priceUsd?: number | null;
              liquidityUsd?: number | null;
              volume24hUsd?: number | null;
              poolAddress?: string | null;
              poolCreatedAt?: string | null;
              discoveryVectors?: string[];
              rank?: number;
            }> : [],
          });
        } else {
          if (stopped) return;
          const unavailableSnapshot = {
            snapshotId: String(existing['snapshotId'] ?? snapshotId),
            capturedAt: String(existing['capturedAt'] ?? capturedAt),
            freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
            sources: { discovery: { ok: false, freshness: 'unavailable' } },
            tokens: Array.isArray(existing['tokens']) ? existing['tokens'] as Array<{
              network: string;
              address: string;
              symbol: string;
              name?: string | null;
              priceUsd?: number | null;
              liquidityUsd?: number | null;
              volume24hUsd?: number | null;
              poolAddress?: string | null;
              poolCreatedAt?: string | null;
              discoveryVectors?: string[];
              rank?: number;
            }> : [],
          };
          await writeDiscoveryState(unavailableSnapshot);
        }
      } catch {
        if (stopped) return;
        // If we can't parse, write unavailable
        const unavailableSnapshot = {
          snapshotId,
          capturedAt,
          freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
          sources: { discovery: { ok: false, freshness: 'unavailable' } },
          tokens: [],
        };
        await writeDiscoveryState(unavailableSnapshot);
      }
    } else {
      // No prior snapshot exists — write an explicit unavailable snapshot
      if (stopped) return;
      const unavailableSnapshot = {
        snapshotId,
        capturedAt,
        freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
        sources: { discovery: { ok: false, freshness: 'unavailable' } },
        tokens: [],
      };
      await writeDiscoveryState(unavailableSnapshot);
    }
    await redis.set('market-intel:last-error', JSON.stringify({
      source: 'discovery',
      occurredAt: new Date().toISOString(),
    }), 'EX', 3600);
  }

  async function refreshRegime(): Promise<void> {
    for (const benchmarkSymbol of benchmarkSymbols) {
      try {
        const candleResult = await providerRegistry.binance.candles(benchmarkSymbol, { interval: '1h', limit: 100 });
        if (stopped) return;
        const candles = candleResult.data;

        if (!candles || candles.length === 0) {
          if (stopped) return;
          await writeRegimeSnapshot(benchmarkSymbol, {
            benchmarkSymbol,
            evaluatedAt: new Date().toISOString(),
            freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: regimePollMs * 2 },
            pass: false,
            reasons: ['No candle data available'],
            details: {},
          });
          continue;
        }

        // Use evaluateRegime from market-data — import dynamically to avoid circular deps
        const { evaluateRegime } = await import('@herobids/market-data');
        const regimeResult = evaluateRegime(candles, { benchmarkSymbol });
        if (stopped) return;

        const snapshot = {
          benchmarkSymbol,
          evaluatedAt: new Date().toISOString(),
          freshness: { state: 'fresh' as const, ageMs: 0, maxAllowedAgeMs: regimePollMs * 2 },
          pass: regimeResult.pass,
          reasons: regimeResult.reasons,
          details: regimeResult.details,
        };

        if (stopped) return;
        await writeRegimeSnapshot(benchmarkSymbol, snapshot);
        logger.debug({ benchmarkSymbol, pass: regimeResult.pass }, 'Regime snapshot refreshed');
      } catch (err) {
        if (stopped) return;
        logger.error({ err, benchmarkSymbol }, 'Regime refresh failed');
        await redis.set('market-intel:last-error', JSON.stringify({
          source: 'regime',
          benchmarkSymbol,
          occurredAt: new Date().toISOString(),
        }), 'EX', 3600);
      }
    }
  }

  async function writeRegimeSnapshot(benchmarkSymbol: string, snapshot: Record<string, unknown>): Promise<void> {
    if (stopped) return;
    await redis.set(
      `market-intel:regime:${benchmarkSymbol}`,
      JSON.stringify(snapshot),
      'PX',
      regimePollMs * 3,
    );
  }

  async function stop(): Promise<void> {
    stopped = true;
    stopLoops();
    deps.monitor?.stop();
    if (leaderElection) {
      await leaderElection.stop();
    }
  }

  function isLeader(): boolean {
    return leaderElection?.isLeader() ?? false;
  }

  return { start, stop, isLeader };
}
