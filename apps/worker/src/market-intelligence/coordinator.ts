import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';
import crypto from 'node:crypto';
import { createLeaderElection, type LeaderElection } from './leader-election.js';
import type { TradertonReadResult } from '@herobids/domain';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import type { MarketMonitor } from './monitor.js';
import { recordProviderSuccess, recordProviderFailure, recordFreshnessMode, recordRateLimitThrottle } from './provider-counters.js';

/**
 * The narrow `check_regime` read-boundary port the coordinator consumes (L3 Q2
 * regime re-point). Structurally identical to the read tools' boundary; the
 * composition root binds a SYSTEM subject + deadline. When absent, regime
 * refresh records a provider failure and writes an unavailable snapshot.
 */
export interface CheckRegimeBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

/**
 * The narrow `discover_tokens` read-boundary port the coordinator consumes (the
 * discovery re-point). Structurally identical to the regime boundary; the
 * composition root binds the same SYSTEM subject + deadline. When absent,
 * discovery refresh records a provider failure and writes an unavailable
 * snapshot (no in-process discovery fallback — the discovery engine is gone
 * from herobids).
 */
export interface DiscoveryBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

/** The subset of the boundary `check_regime` success payload the coordinator needs. */
interface RegimeBoundaryPayload {
  pass: boolean;
  reasons: string[];
  details: Record<string, unknown>;
  freshness?: { provider: string; source: 'upstream' | 'cache'; ageMs: number; isStale: boolean };
}

/** Narrow the boundary `check_regime` success payload (`unknown` over the wire). */
function parseRegimePayload(data: unknown): RegimeBoundaryPayload {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawFreshness = record['freshness'];
  let freshness: RegimeBoundaryPayload['freshness'];
  if (rawFreshness && typeof rawFreshness === 'object') {
    const f = rawFreshness as Record<string, unknown>;
    freshness = {
      provider: typeof f['provider'] === 'string' ? f['provider'] : 'binance',
      source: f['source'] === 'cache' ? 'cache' : 'upstream',
      ageMs: typeof f['ageMs'] === 'number' ? f['ageMs'] : 0,
      isStale: f['isStale'] === true,
    };
  }
  return {
    pass: record['pass'] === true,
    reasons: Array.isArray(record['reasons']) ? (record['reasons'] as string[]) : [],
    details: (record['details'] && typeof record['details'] === 'object')
      ? (record['details'] as Record<string, unknown>)
      : {},
    ...(freshness ? { freshness } : {}),
  };
}

/** A discovery token as narrowed from the boundary `discover_tokens` payload. */
interface DiscoveryBoundaryToken {
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
}

/** The subset of the boundary `discover_tokens` success payload the coordinator needs. */
interface DiscoveryBoundaryPayload {
  tokens: DiscoveryBoundaryToken[];
  freshness: { source: 'upstream' | 'cache' } | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Narrow the boundary `discover_tokens` success payload (`unknown` over the wire). */
function parseDiscoveryPayload(data: unknown): DiscoveryBoundaryPayload {
  const record = (data ?? {}) as Record<string, unknown>;
  const rawTokens = Array.isArray(record['tokens']) ? record['tokens'] : [];
  const tokens: DiscoveryBoundaryToken[] = rawTokens.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    return {
      network: typeof t['network'] === 'string' ? t['network'] : '',
      address: typeof t['address'] === 'string' ? t['address'] : '',
      symbol: typeof t['symbol'] === 'string' ? t['symbol'] : '',
      name: optionalString(t['name']),
      priceUsd: optionalNumber(t['priceUsd']),
      liquidityUsd: optionalNumber(t['liquidityUsd']),
      volume24hUsd: optionalNumber(t['volume24hUsd']),
      poolAddress: optionalString(t['poolAddress']),
      poolCreatedAt: optionalString(t['poolCreatedAt']),
      discoveryVectors: Array.isArray(t['discoveryVectors'])
        ? (t['discoveryVectors'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    };
  });

  const rawFreshness = record['freshness'];
  let freshness: DiscoveryBoundaryPayload['freshness'] = null;
  if (rawFreshness && typeof rawFreshness === 'object') {
    const f = rawFreshness as Record<string, unknown>;
    freshness = { source: f['source'] === 'cache' ? 'cache' : 'upstream' };
  }

  return { tokens, freshness };
}

const logger = createLogger('market-data-coordinator');

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
  /** Max discovery results per poll. Default: 50 */
  discoveryMaxResults?: number;
}

export interface CoordinatorDeps {
  redis: Redis;
  publisher: InstanceEventPublisher;
  /** Optional monitor — started/stopped with this coordinator under the same leader lease. */
  monitor?: MarketMonitor;
  /**
   * The `check_regime` read boundary (L3 Q2 regime re-point). Bound to a SYSTEM
   * subject by the worker composition root. When absent, regime refresh records
   * a provider failure and writes an unavailable snapshot (no in-process
   * candle/regime fallback).
   */
  checkRegimeBoundary?: CheckRegimeBoundary;
  /**
   * The `discover_tokens` read boundary (discovery re-point). Bound to the same
   * SYSTEM subject by the worker composition root. When absent, discovery
   * refresh records a provider failure and writes an unavailable snapshot (no
   * in-process discovery fallback).
   */
  discoveryBoundary?: DiscoveryBoundary;
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
    discoveryMaxResults = 50,
  } = config;

  const { redis, checkRegimeBoundary, discoveryBoundary } = deps;

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
    // Publish coordinator config to Redis so the admin API can read known symbols
    void redis.set(
      'market-intel:coordinator-config',
      JSON.stringify({ benchmarkSymbols, networks, discoveryPollMs, regimePollMs }),
    );
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

  /** Record a rate-limit throttle for both discovery providers (they share one call). */
  function recordDiscoveryThrottle(): void {
    void recordRateLimitThrottle(redis, 'dexscreener', 'discovery');
    void recordRateLimitThrottle(redis, 'geckoterminal', 'discovery');
  }

  /** Record a generic provider failure for both discovery providers. */
  function recordDiscoveryFailure(): void {
    void recordProviderFailure(redis, 'dexscreener', 'discovery');
    void recordProviderFailure(redis, 'geckoterminal', 'discovery');
  }

  async function refreshDiscovery(): Promise<void> {
    const snapshotId = crypto.randomUUID();
    const capturedAt = new Date().toISOString();

    // Discovery is sourced over the Traderton `discover_tokens` boundary (the
    // discovery re-point). No in-process discovery. When the boundary is
    // unconfigured, record a failure + write an unavailable snapshot — never
    // fall back to a local discovery computation.
    if (!discoveryBoundary) {
      if (stopped) return;
      recordDiscoveryFailure();
      await markDiscoveryStale(snapshotId, capturedAt);
      return;
    }

    const result = await discoveryBoundary.invoke({
      toolName: 'discover_tokens',
      payload: { networks, maxResults: discoveryMaxResults },
    });
    if (stopped) return;

    switch (result.kind) {
      case 'success': {
        const payload = parseDiscoveryPayload(result.data);
        const tokens = payload.tokens;

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

        // Record success and freshness counters for the discovery providers.
        // dexscreener and geckoterminal run together in a single discovery
        // result, so both share the same freshness observation from the
        // aggregated boundary payload.
        const discoveryFreshnessMode = payload.freshness?.source === 'upstream' ? 'fresh' : 'cached';
        void recordProviderSuccess(redis, 'dexscreener', 'discovery');
        void recordProviderSuccess(redis, 'geckoterminal', 'discovery');
        void recordFreshnessMode(redis, 'dexscreener', 'discovery', discoveryFreshnessMode);
        void recordFreshnessMode(redis, 'geckoterminal', 'discovery', discoveryFreshnessMode);

        logger.debug({ snapshotId, tokenCount: tokens.length }, 'Discovery snapshot refreshed');
        break;
      }
      case 'failure': {
        logger.error({ code: result.code, message: result.message }, 'Discovery refresh failed — marking stale');
        if (result.code === 'rate_limit.exceeded') {
          recordDiscoveryThrottle();
        } else {
          recordDiscoveryFailure();
        }
        await markDiscoveryStale(snapshotId, capturedAt);
        break;
      }
      case 'transport_error': {
        logger.error({ message: result.message }, 'Discovery refresh failed — boundary unreachable');
        recordDiscoveryFailure();
        await markDiscoveryStale(snapshotId, capturedAt);
        break;
      }
      case 'in_progress':
        // Non-terminal — record nothing and leave the existing snapshot
        // unchanged (a later poll refreshes it).
        logger.debug({ snapshotId }, 'Discovery refresh in progress — leaving snapshot unchanged');
        break;
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
            freshness: { state: 'unavailable' as const, ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
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
          freshness: { state: 'unavailable' as const, ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
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
        freshness: { state: 'unavailable' as const, ageMs: 0, maxAllowedAgeMs: discoveryMaxAgeMs },
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
      // L3 Q2: regime is evaluated over the Traderton `check_regime` boundary
      // (candles fetched behind the boundary). No in-process candle fetch. When
      // the boundary is unconfigured, record a failure + write an unavailable
      // snapshot — never fall back to a local regime computation.
      if (!checkRegimeBoundary) {
        if (stopped) return;
        void recordProviderFailure(redis, 'binance', 'regime');
        await writeRegimeSnapshot(benchmarkSymbol, {
          benchmarkSymbol,
          evaluatedAt: new Date().toISOString(),
          freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: regimePollMs * 2 },
          pass: false,
          reasons: ['Regime boundary not configured'],
          details: {},
        });
        await recordRegimeError(benchmarkSymbol);
        continue;
      }

      const result = await checkRegimeBoundary.invoke({
        toolName: 'check_regime',
        payload: { benchmarkSymbol },
      });
      if (stopped) return;

      switch (result.kind) {
        case 'success': {
          const payload = parseRegimePayload(result.data);
          // Re-source provider/freshness telemetry from the boundary result (parity).
          void recordProviderSuccess(redis, 'binance', 'regime');
          void recordFreshnessMode(
            redis,
            'binance',
            'regime',
            payload.freshness?.source === 'upstream' ? 'fresh' : 'cached',
          );
          await writeRegimeSnapshot(benchmarkSymbol, {
            benchmarkSymbol,
            evaluatedAt: new Date().toISOString(),
            freshness: {
              state: 'fresh',
              ageMs: payload.freshness?.ageMs ?? 0,
              maxAllowedAgeMs: regimePollMs * 2,
            },
            pass: payload.pass,
            reasons: payload.reasons,
            details: payload.details,
          });
          logger.debug({ benchmarkSymbol, pass: payload.pass }, 'Regime snapshot refreshed');
          break;
        }
        case 'failure': {
          logger.error({ code: result.code, message: result.message, benchmarkSymbol }, 'Regime refresh failed');
          if (result.code === 'rate_limit.exceeded') {
            void recordRateLimitThrottle(redis, 'binance', 'regime');
          } else {
            void recordProviderFailure(redis, 'binance', 'regime');
          }
          await writeRegimeSnapshot(benchmarkSymbol, {
            benchmarkSymbol,
            evaluatedAt: new Date().toISOString(),
            freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: regimePollMs * 2 },
            pass: false,
            reasons: [result.message],
            details: {},
          });
          await recordRegimeError(benchmarkSymbol);
          break;
        }
        case 'transport_error': {
          logger.error({ message: result.message, benchmarkSymbol }, 'Regime refresh failed — boundary unreachable');
          void recordProviderFailure(redis, 'binance', 'regime');
          await writeRegimeSnapshot(benchmarkSymbol, {
            benchmarkSymbol,
            evaluatedAt: new Date().toISOString(),
            freshness: { state: 'unavailable', ageMs: 0, maxAllowedAgeMs: regimePollMs * 2 },
            pass: false,
            reasons: [result.message],
            details: {},
          });
          await recordRegimeError(benchmarkSymbol);
          break;
        }
        case 'in_progress':
          // Non-terminal — record nothing and leave the existing snapshot
          // unchanged (a later poll refreshes it).
          logger.debug({ benchmarkSymbol }, 'Regime refresh in progress — leaving snapshot unchanged');
          break;
      }
    }
  }

  /** Record a regime refresh error marker (best-effort). */
  async function recordRegimeError(benchmarkSymbol: string): Promise<void> {
    if (stopped) return;
    await redis.set('market-intel:last-error', JSON.stringify({
      source: 'regime',
      benchmarkSymbol,
      occurredAt: new Date().toISOString(),
    }), 'EX', 3600);
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
