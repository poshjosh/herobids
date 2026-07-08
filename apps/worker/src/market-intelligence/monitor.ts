import type { Redis } from 'ioredis';
import pino from 'pino';
import crypto from 'node:crypto';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import type {
  MarketWatchTriggeredPayload,
  MarketDiscoveryDetectedPayload,
  MarketRegimeChangedPayload,
  AgentWakePayload,
  AgentWakeSource,
  WatchThresholdWakeContext,
  DiscoveryDeltaWakeContext,
  RegimeChangeWakeContext,
} from '@herobids/domain';
import { summarizeActiveWatches } from '../runtime-composition.js';
import { type WatchEntry, parseWatch, toRuntimeActiveWatch } from '../watch-types.js';

const logger = pino({ name: 'market-monitor' });

// --- Rate limit constants ---
const MAX_EVENTS_PER_AGENT_PER_MINUTE = 20;
const DEFAULT_WAKE_COOLDOWN_MS = 30_000;
const DEFAULT_WAKE_COALESCING_WINDOW_MS = 3_000;
const MAX_COALESCED_EVENT_IDS = 5;
const DISCOVERY_COOLDOWN_MS = 600_000; // 10 minutes
const REGIME_COOLDOWN_MS = 300_000; // 5 minutes

export interface WakePolicyEntry {
  /** Cooldown in ms for this wake source. */
  cooldownMs?: number;
}

export interface MonitorConfig {
  /** Enable/disable monitor. Default: true */
  enabled?: boolean;
  /** Monitor evaluation interval in ms. Default: 15000 */
  evaluationIntervalMs?: number;
  /** Enable/disable individual monitor families */
  families?: {
    watchThresholds?: boolean;
    discoveryDeltas?: boolean;
    regimeChanges?: boolean;
  };
  /** Wake coalescing window in ms. Default: 3000 */
  wakeCoalescingWindowMs?: number;
  /** Wake cooldown in ms. Default: 30000 */
  wakeCooldownMs?: number;
  /** Per-source wake policy overrides. Falls back to wakeCooldownMs for unknown sources. */
  wakePolicy?: Record<string, WakePolicyEntry>;
}

export interface MonitorDeps {
  redis: Redis;
  publisher: InstanceEventPublisher;
}

interface PendingWake {
  agentId: string;
  /** Wake source this bucket belongs to (determines key namespace and cooldown). */
  source: AgentWakeSource;
  eventIds: string[];
  scheduledAt: number;
  /** Monotonically incremented on every enqueue — used as a CAS token by flush. */
  generation: number;
  /** Human-readable reason derived from the triggering event (first enqueue wins on coalesce). */
  primaryReason?: string;
  /** Typed wake source for the primary triggering event (first enqueue wins on coalesce). */
  primarySource?: AgentWakeSource;
  /** Structured context specific to primarySource (first enqueue wins on coalesce). */
  primaryContext?: WatchThresholdWakeContext | DiscoveryDeltaWakeContext | RegimeChangeWakeContext;
}

export interface MarketMonitor {
  start(): void;
  stop(): void;
  /** Run a single evaluation cycle (exposed for testing) */
  evaluate(): Promise<void>;
  /** Flush pending wakes (exposed for testing) */
  flushWakes(): Promise<void>;
  /** Get observability metrics */
  getMetrics(): {
    eventsEmitted: number;
    eventsSuppressed: number;
    wakeRequestsEmitted: number;
    wakeRequestsCoalesced: number;
    wakeRequestsSuppressed: number;
    evaluationFailures: number;
  };
}

export function createMarketMonitor(config: MonitorConfig, deps: MonitorDeps): MarketMonitor {
  const { enabled = true, evaluationIntervalMs = 15_000 } = config;
  const WAKE_COALESCING_WINDOW_MS = config.wakeCoalescingWindowMs ?? DEFAULT_WAKE_COALESCING_WINDOW_MS;
  const DEFAULT_COOLDOWN_MS = config.wakeCooldownMs ?? DEFAULT_WAKE_COOLDOWN_MS;

  /** Resolve cooldown for a wake source: wakePolicy override → global fallback → hard default. */
  function getWakeCooldownMs(source: AgentWakeSource): number {
    return config.wakePolicy?.[source]?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }
  const families = {
    watchThresholds: config.families?.watchThresholds ?? true,
    discoveryDeltas: config.families?.discoveryDeltas ?? true,
    regimeChanges: config.families?.regimeChanges ?? true,
  };
  const { redis, publisher } = deps;

  let evaluationTimer: ReturnType<typeof setInterval> | undefined;
  let wakeFlushTimer: ReturnType<typeof setInterval> | undefined;
  let wakeFlushInFlight = false;
  let wakeMutationChain: Promise<void> = Promise.resolve();
  let stopped = false;

  // Observability counters
  const metrics = {
    eventsEmitted: 0,
    eventsSuppressed: 0,
    wakeRequestsEmitted: 0,
    wakeRequestsCoalesced: 0,
    wakeRequestsSuppressed: 0,
    evaluationFailures: 0,
  };

  function start(): void {
    if (!enabled) {
      logger.info('Market monitor disabled');
      return;
    }
    stopped = false;
    evaluationTimer = setInterval(() => {
      if (stopped) return;
      void evaluate();
    }, evaluationIntervalMs);
    wakeFlushTimer = setInterval(() => {
      if (stopped || wakeFlushInFlight) return;
      void flushPendingWakes().catch((err) => {
        logger.error({ err }, 'Wake flush cycle failed');
      });
    }, WAKE_COALESCING_WINDOW_MS);
    // Run first evaluation immediately
    void evaluate();
  }

  function stop(): void {
    stopped = true;
    clearInterval(evaluationTimer);
    clearInterval(wakeFlushTimer);
    wakeFlushInFlight = false;
    wakeMutationChain = Promise.resolve();
  }

  async function evaluate(): Promise<void> {
    if (stopped) return;
    try {
      if (families.watchThresholds) await evaluateWatches();
      if (families.discoveryDeltas) await evaluateDiscoveryDeltas();
      if (families.regimeChanges) await evaluateRegimeChanges();
    } catch (err) {
      metrics.evaluationFailures++;
      logger.error({ err }, 'Monitor evaluation cycle failed');
    }
  }

  // -----------------------------------------------------------------------
  // Watch threshold evaluation
  // -----------------------------------------------------------------------

  async function refreshSummaryCache(agentId: string, watches: WatchEntry[]): Promise<void> {
    try {
      const summary = summarizeActiveWatches(watches.map(toRuntimeActiveWatch));
      if (summary.totalCount === 0) {
        await redis.hdel(`agent:watches:summary:${agentId}`, 'summary');
      } else {
        await redis.hset(`agent:watches:summary:${agentId}`, 'summary', JSON.stringify(summary));
      }
    } catch (err) {
      logger.warn({ err, agentId }, 'Failed to refresh watch summary cache from monitor');
    }
  }

  async function evaluateWatches(): Promise<void> {
    if (stopped) return;
    // Find all agent watch keys
    const watchKeys = await scanKeys('agent:watches:*');
    if (stopped) return;

    for (const key of watchKeys) {
      const agentId = key.replace('agent:watches:', '');
      if (agentId.startsWith('summary:')) continue;

      const raw = await redis.hgetall(key);
      if (!raw || Object.keys(raw).length === 0) continue;

      const watches: WatchEntry[] = [];
      for (const value of Object.values(raw)) {
        const parsed = parseWatch(value);
        if (parsed) {
          watches.push(parsed);
        }
      }

      if (watches.length === 0) continue;

      const refreshedWatches: WatchEntry[] = [];

      // Get latest price data from shared state
      const priceMap = await getLatestPrices(watches);
      if (stopped) return;

      for (const watch of watches) {
        const effectiveChain = watch.resolvedChain ?? watch.chain;
        const effectiveSymbol = watch.resolvedSymbol ?? watch.symbol;
        const priceKey = `${effectiveChain}:${effectiveSymbol}`;
        const priceData = priceMap.get(priceKey);
        if (!priceData) {
          refreshedWatches.push(watch);
          continue;
        }

        const conditionMet = watch.condition === 'above'
          ? priceData.priceUsd >= watch.thresholdPrice
          : priceData.priceUsd <= watch.thresholdPrice;

        // Edge trigger: only fire on false -> true transition
        const isTriggered = watch.lastConditionMet === false && conditionMet;

        // Always update lastCheckedAt so staleness is observable in the API/context.
        // Only persist the full entry if the condition state changed (or on first check).
        const conditionChanged = conditionMet !== watch.lastConditionMet;
        const updated: WatchEntry = { ...watch, lastConditionMet: conditionMet, lastCheckedAt: new Date().toISOString() };
        await redis.hset(key, watch.watchId, JSON.stringify(updated));
        if (conditionChanged && !conditionMet) {
          // When condition resets to false, clear the dedupe key so the next
          // false→true crossing is not suppressed within the same day.
          await redis.del(`market-monitor:dedupe:watch:${watch.watchId}:cross:${watch.condition}`);
        }

        if (isTriggered) {
          if (stopped) return;
          // Check dedupe
          const dedupeKey = `watch:${watch.watchId}:cross:${watch.condition}`;
          const suppressed = await checkDedupe(dedupeKey, 0); // No time-based cooldown for watches
          if (suppressed) { metrics.eventsSuppressed++; continue; }

          // Check rate limit
          const rateLimited = await checkRateLimit(agentId, 'watch_threshold');
          if (rateLimited) { metrics.eventsSuppressed++; continue; }

          const eventId = crypto.randomUUID();
          const payload: MarketWatchTriggeredPayload = {
            eventId,
            monitorType: 'watch_threshold',
            watchId: watch.watchId,
            symbol: effectiveSymbol,
            chain: effectiveChain,
            condition: watch.condition,
            thresholdPrice: watch.thresholdPrice,
            currentPrice: priceData.priceUsd,
            priceSource: priceData.source,
            stale: priceData.stale,
            ...(watch.note ? { note: watch.note } : {}),
            triggeredAt: new Date().toISOString(),
            ...(watch.purpose ? { purpose: watch.purpose } : {}),
            ...(watch.instrument?.venue ? { instrumentVenue: watch.instrument.venue } : {}),
            ...(watch.instrument?.instrumentId ? { instrumentId: watch.instrument.instrumentId } : {}),
            ...(watch.coverage?.positionKey ? { positionKey: watch.coverage.positionKey } : {}),
            ...(watch.schemaVersion ? { schemaVersion: watch.schemaVersion } : {}),
          };

          await publisher.emitMarketWatchTriggered(agentId, payload);
          await recordDedupe(dedupeKey);
          await incrementRateCounter(agentId, 'watch_threshold');
          await enqueueWake(
            agentId,
            eventId,
            `${effectiveSymbol} crossed ${watch.condition === 'above' ? 'above' : 'below'} ${watch.thresholdPrice}`,
            'watch_threshold',
            {
              symbol: effectiveSymbol,
              chain: effectiveChain,
              condition: watch.condition,
              thresholdPrice: watch.thresholdPrice,
              currentPrice: priceData.priceUsd,
              stale: priceData.stale,
              triggeredAt: payload.triggeredAt,
              watchId: watch.watchId,
              ...(watch.note ? { note: watch.note } : {}),
              ...(watch.purpose ? { purpose: watch.purpose } : {}),
              ...(watch.instrument?.venue ? { instrumentVenue: watch.instrument.venue } : {}),
              ...(watch.instrument?.instrumentId ? { instrumentId: watch.instrument.instrumentId } : {}),
              ...(watch.coverage?.positionKey ? { positionKey: watch.coverage.positionKey } : {}),
              ...(watch.schemaVersion ? { schemaVersion: watch.schemaVersion } : {}),
            },
          );
          metrics.eventsEmitted++;
          logger.info({ agentId, watchId: watch.watchId, symbol: effectiveSymbol, pinnedChain: effectiveChain }, 'Watch triggered');
        }

        refreshedWatches.push(updated);
      }

      // Refresh the cached summary so the agent sees updated watch state on next tick.
      await refreshSummaryCache(agentId, refreshedWatches);
    }
  }

  // -----------------------------------------------------------------------
  // Discovery delta evaluation
  // -----------------------------------------------------------------------

  async function evaluateDiscoveryDeltas(): Promise<void> {
    if (stopped) return;
    const snapshotRaw = await redis.get('market-intel:discovery:latest');
    if (!snapshotRaw) return;

    let snapshot: { tokens: Array<{ network: string; address: string; symbol: string; rank: number; liquidityUsd: number; volume24hUsd: number; discoveryVectors: string[] }> };
    try {
      snapshot = JSON.parse(snapshotRaw) as typeof snapshot;
    } catch { return; }

    if (!snapshot.tokens || snapshot.tokens.length === 0) return;

    // Get previous snapshot for delta comparison
    const prevRaw = await redis.get('market-monitor:discovery:previous-snapshot');
    const prevTokenKeys = new Set<string>();
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw) as { tokens: Array<{ network: string; address: string; discoveryVectors?: string[] }> };
        for (const prevToken of prev.tokens) {
          prevTokenKeys.add(`${prevToken.network}:${prevToken.address}`);
        }
      } catch { /* no previous */ }
    }

    // Store current snapshot for next delta comparison
    await redis.set('market-monitor:discovery:previous-snapshot', snapshotRaw, 'EX', 3600);
    if (stopped) return;

    // Get all agent IDs that have active watches or are running
    const agentIds = await getActiveAgentIds();
    if (stopped) return;

    for (const token of snapshot.tokens) {
      const tokenKey = `${token.network}:${token.address}`;

      // Check entered_top_set
      if (!prevTokenKeys.has(tokenKey)) {
        const dedupeKey = `discovery:${tokenKey}:reason:entered_top_set`;
        const suppressed = await checkDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
        if (suppressed) continue;

        const eventId = crypto.randomUUID();
        const payload: MarketDiscoveryDetectedPayload = {
          eventId,
          monitorType: 'discovery_delta',
          symbol: token.symbol,
          network: token.network,
          address: token.address,
          reason: 'entered_top_set',
          rank: token.rank,
          liquidityUsd: token.liquidityUsd,
          volume24hUsd: token.volume24hUsd,
          discoveryVectors: token.discoveryVectors,
          detectedAt: new Date().toISOString(),
        };

        await recordDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
        if (stopped) return;

        for (const agentId of agentIds) {
          const rateLimited = await checkRateLimit(agentId, 'discovery_delta');
          if (rateLimited) continue;
          await publisher.emitMarketDiscoveryDetected(agentId, payload);
          await incrementRateCounter(agentId, 'discovery_delta');
          await enqueueWake(
            agentId,
            eventId,
            `${token.symbol} entered top discovery set`,
            'discovery_delta',
            {
              symbol: token.symbol,
              network: token.network,
              address: token.address,
              reason: 'entered_top_set',
              rank: token.rank,
              liquidityUsd: token.liquidityUsd,
              volume24hUsd: token.volume24hUsd,
              detectedAt: payload.detectedAt,
            },
          );
        }

        logger.info({ symbol: token.symbol, network: token.network }, 'Discovery delta: entered top set');
      }

      // Check multi_vector_confirmation
      if (token.discoveryVectors && token.discoveryVectors.length >= 2 && prevTokenKeys.has(tokenKey)) {
        const dedupeKey = `discovery:${tokenKey}:reason:multi_vector_confirmation`;
        const suppressed = await checkDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
        if (suppressed) continue;

        // Check if previous had fewer vectors
        const prevSnapshotTokens = prevRaw ? (JSON.parse(prevRaw) as { tokens: Array<{ network: string; address: string; discoveryVectors?: string[] }> }).tokens : [];
        const prevToken = prevSnapshotTokens.find((t) => `${t.network}:${t.address}` === tokenKey);
        if (prevToken && (prevToken.discoveryVectors?.length ?? 0) < 2) {
          const eventId = crypto.randomUUID();
          const payload: MarketDiscoveryDetectedPayload = {
            eventId,
            monitorType: 'discovery_delta',
            symbol: token.symbol,
            network: token.network,
            address: token.address,
            reason: 'multi_vector_confirmation',
            rank: token.rank,
            liquidityUsd: token.liquidityUsd,
            volume24hUsd: token.volume24hUsd,
            discoveryVectors: token.discoveryVectors,
            detectedAt: new Date().toISOString(),
          };

          await recordDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
          if (stopped) return;

          for (const agentId of agentIds) {
            const rateLimited = await checkRateLimit(agentId, 'discovery_delta');
            if (rateLimited) continue;
            await publisher.emitMarketDiscoveryDetected(agentId, payload);
            await incrementRateCounter(agentId, 'discovery_delta');
            await enqueueWake(
              agentId,
              eventId,
              `${token.symbol} confirmed by multiple discovery vectors`,
              'discovery_delta',
              {
                symbol: token.symbol,
                network: token.network,
                address: token.address,
                reason: 'multi_vector_confirmation',
                rank: token.rank,
                liquidityUsd: token.liquidityUsd,
                volume24hUsd: token.volume24hUsd,
                detectedAt: payload.detectedAt,
              },
            );
          }

          logger.info({ symbol: token.symbol, network: token.network }, 'Discovery delta: multi vector confirmation');
        }
      }
    }

    // Check reappeared_after_cooldown
    const antiStalenessWindow = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();
    for (const token of snapshot.tokens) {
      const tokenKey = `${token.network}:${token.address}`;
      if (prevTokenKeys.has(tokenKey)) continue; // Only for tokens not in previous

      const lastSeenScore = await redis.zscore('market-intel:discovery:seen', tokenKey);
      if (lastSeenScore) {
        const lastSeen = Number(lastSeenScore);
        const elapsed = now - lastSeen;
        if (elapsed >= antiStalenessWindow) {
          const dedupeKey = `discovery:${tokenKey}:reason:reappeared_after_cooldown`;
          const suppressed = await checkDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
          if (suppressed) continue;

          const eventId = crypto.randomUUID();
          const payload: MarketDiscoveryDetectedPayload = {
            eventId,
            monitorType: 'discovery_delta',
            symbol: token.symbol,
            network: token.network,
            address: token.address,
            reason: 'reappeared_after_cooldown',
            rank: token.rank,
            liquidityUsd: token.liquidityUsd,
            volume24hUsd: token.volume24hUsd,
            discoveryVectors: token.discoveryVectors,
            detectedAt: new Date().toISOString(),
          };

          await recordDedupe(dedupeKey, DISCOVERY_COOLDOWN_MS);
          if (stopped) return;

          for (const agentId of agentIds) {
            const rateLimited = await checkRateLimit(agentId, 'discovery_delta');
            if (rateLimited) continue;
            await publisher.emitMarketDiscoveryDetected(agentId, payload);
            await incrementRateCounter(agentId, 'discovery_delta');
            await enqueueWake(
              agentId,
              eventId,
              `${token.symbol} reappeared in discovery set`,
              'discovery_delta',
              {
                symbol: token.symbol,
                network: token.network,
                address: token.address,
                reason: 'reappeared_after_cooldown',
                rank: token.rank,
                liquidityUsd: token.liquidityUsd,
                volume24hUsd: token.volume24hUsd,
                detectedAt: payload.detectedAt,
              },
            );
          }

          logger.info({ symbol: token.symbol, network: token.network }, 'Discovery delta: reappeared after cooldown');
        }
      }
    }

    // Update anti-staleness tracking AFTER evaluation so the seen score reflects the
    // previous poll when reappearance is checked, not "just now".
    const seenNow = Date.now();
    const seenPipeline = redis.pipeline();
    for (const token of snapshot.tokens) {
      seenPipeline.zadd('market-intel:discovery:seen', String(seenNow), `${token.network}:${token.address}`);
    }
    await seenPipeline.exec();
  }

  // -----------------------------------------------------------------------
  // Regime change evaluation
  // -----------------------------------------------------------------------

  async function evaluateRegimeChanges(): Promise<void> {
    if (stopped) return;
    const regimeKeys = await scanKeys('market-intel:regime:*');
    if (stopped) return;

    for (const key of regimeKeys) {
      const benchmarkSymbol = key.replace('market-intel:regime:', '');
      const raw = await redis.get(key);
      if (!raw) continue;

      let current: { pass: boolean; details: Record<string, unknown> };
      try {
        current = JSON.parse(raw) as typeof current;
      } catch { continue; }

      // Get previous regime state
      const prevStateKey = `market-monitor:regime:last-state:${benchmarkSymbol}`;
      const prevRaw = await redis.get(prevStateKey);

      let previousPass: boolean | null = null;
      if (prevRaw) {
        try {
          previousPass = (JSON.parse(prevRaw) as { pass: boolean }).pass;
        } catch { /* no previous */ }
      }

      // Store current state for next comparison
      await redis.set(prevStateKey, JSON.stringify({ pass: current.pass }), 'EX', 3600);
      if (stopped) return;

      // Edge trigger: only fire on actual flip
      if (previousPass === null || previousPass === current.pass) continue;

      const previousState = previousPass ? 'favorable' : 'unfavorable';
      const currentState = current.pass ? 'favorable' : 'unfavorable';

      const dedupeKey = `regime:${benchmarkSymbol}:from:${previousState}:to:${currentState}`;
      const suppressed = await checkDedupe(dedupeKey, REGIME_COOLDOWN_MS);
      if (suppressed) continue;

      const agentIds = await getActiveAgentIds();
      const eventId = crypto.randomUUID();
      const payload: MarketRegimeChangedPayload = {
        eventId,
        monitorType: 'regime_change',
        benchmarkSymbol,
        previousState,
        currentState,
        details: current.details,
        changedAt: new Date().toISOString(),
      };

      await recordDedupe(dedupeKey, REGIME_COOLDOWN_MS);
      if (stopped) return;

      for (const agentId of agentIds) {
        const rateLimited = await checkRateLimit(agentId, 'regime_change');
        if (rateLimited) continue;
        await publisher.emitMarketRegimeChanged(agentId, payload);
        await incrementRateCounter(agentId, 'regime_change');
        await enqueueWake(
          agentId,
          eventId,
          `${benchmarkSymbol} regime changed to ${currentState}`,
          'regime_change',
          {
            benchmarkSymbol,
            previousState,
            currentState,
            changedAt: payload.changedAt,
            details: current.details,
          },
        );
      }

      logger.info({ benchmarkSymbol, previousState, currentState }, 'Regime changed');
    }
  }

  // -----------------------------------------------------------------------
  // Wake coalescing — Redis-backed for failover safety
  // -----------------------------------------------------------------------

  function wakeKey(agentId: string, source: AgentWakeSource): string {
    return `market-monitor:wake:${agentId}:${source}`;
  }

  function lastWakeKey(agentId: string, source: AgentWakeSource): string {
    return `market-monitor:wake:last:${agentId}:${source}`;
  }

  function withWakeMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = wakeMutationChain.then(operation, operation);
    wakeMutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function enqueueWake(
    agentId: string,
    eventId: string,
    reason?: string,
    source?: AgentWakeSource,
    context?: WatchThresholdWakeContext | DiscoveryDeltaWakeContext | RegimeChangeWakeContext,
  ): Promise<void> {
    const effectiveSource: AgentWakeSource = source ?? 'watch_threshold';
    const sourceCooldown = getWakeCooldownMs(effectiveSource);

    return withWakeMutationLock(async () => {
      const key = wakeKey(agentId, effectiveSource);
      const wakeBucketTtlMs = Math.max(WAKE_COALESCING_WINDOW_MS * 3, sourceCooldown + WAKE_COALESCING_WINDOW_MS);
      const existingRaw = await redis.get(key);
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw) as PendingWake;
          if (existing.eventIds.length < MAX_COALESCED_EVENT_IDS) {
            existing.eventIds.push(eventId);
          }
          existing.generation = (existing.generation ?? 0) + 1;
          // Primary source/context stay from the first enqueue (coalescing keeps first-wins semantics)
          await redis.set(key, JSON.stringify(existing), 'PX', wakeBucketTtlMs);
          metrics.wakeRequestsCoalesced++;
        } catch {
          // Malformed — overwrite
          const wake: PendingWake = { agentId, source: effectiveSource, eventIds: [eventId], scheduledAt: Date.now() + WAKE_COALESCING_WINDOW_MS, generation: 1, primaryReason: reason, primarySource: source, primaryContext: context };
          await redis.set(key, JSON.stringify(wake), 'PX', wakeBucketTtlMs);
        }
      } else {
        const wake: PendingWake = { agentId, source: effectiveSource, eventIds: [eventId], scheduledAt: Date.now() + WAKE_COALESCING_WINDOW_MS, generation: 1, primaryReason: reason, primarySource: source, primaryContext: context };
        await redis.set(key, JSON.stringify(wake), 'PX', wakeBucketTtlMs);
      }
    });
  }

  /**
   * Flush pending wake buckets.
   *
   * Migration note: old-format buckets (pre source-scoped keys, without a `source`
   * field in the JSON payload) may still exist in Redis after deploy. They will be
   * parsed and flushed once on the first cycle. The defensive check below defaults
   * missing `source` to `"watch_threshold"` to avoid `undefined` key suffixes.
   * This one-time blast radius is acceptable. Stale buckets expire via TTL naturally.
   */
  async function flushPendingWakes(): Promise<void> {
    if (stopped || wakeFlushInFlight) return;
    wakeFlushInFlight = true;
    try {
      // Phase 1: Claim eligible wake buckets under the mutation lock.
      // This is a short critical section that only reads/updates Redis state
      // without external I/O, so concurrent enqueues are not blocked for long.
      const claimed = await withWakeMutationLock(async () => {
        const now = Date.now();
        const wakeKeys = await scanKeys('market-monitor:wake:*');
        if (stopped) return [];

        const eligible: Array<{ key: string; wake: PendingWake; lastWakeKey: string; sourceCooldownMs: number }> = [];

        for (const key of wakeKeys) {
          if (key.includes(':last:')) continue;

          const raw = await redis.get(key);
          if (!raw) continue;

          let wake: PendingWake;
          try {
            wake = JSON.parse(raw) as PendingWake;
          } catch {
            continue;
          }

          // Defensive: old-format buckets (pre source-scoped keys) lack `source`.
          // Default to legacy behaviour so they fire once on first flush instead
          // of producing `market-monitor:wake:last:<agentId>:undefined` keys.
          if (!wake.source) {
            logger.warn({ agentId: wake.agentId }, 'Wake bucket missing source field, defaulting to watch_threshold');
            wake.source = 'watch_threshold';
          }

          if (now < wake.scheduledAt) continue;

          const sourceCooldownMs = getWakeCooldownMs(wake.source);
          const effectiveLastWakeKey = lastWakeKey(wake.agentId, wake.source);
          const lastWakeRaw = await redis.get(effectiveLastWakeKey);
          if (stopped) return [];
          if (lastWakeRaw) {
            const lastWakeTime = Number(lastWakeRaw);
            if (now - lastWakeTime < sourceCooldownMs) {
              metrics.wakeRequestsSuppressed++;
              const nextEligibleAt = lastWakeTime + sourceCooldownMs;
              wake.scheduledAt = nextEligibleAt;
              const nextWakeBucketTtlMs = Math.max(
                WAKE_COALESCING_WINDOW_MS * 3,
                nextEligibleAt - now + WAKE_COALESCING_WINDOW_MS,
              );
              await redis.set(key, JSON.stringify(wake), 'PX', nextWakeBucketTtlMs);
              logger.debug({ agentId: wake.agentId, source: wake.source }, 'Wake suppressed by cooldown');
              continue;
            }
          }

          eligible.push({ key, wake, lastWakeKey: effectiveLastWakeKey, sourceCooldownMs });
        }

        return eligible;
      });

      if (!claimed || claimed.length === 0) return;

      // Phase 2: Publish outside the lock so concurrent enqueues can proceed.
      const now = Date.now();
      for (const { key, wake, lastWakeKey, sourceCooldownMs } of claimed) {
        if (stopped) return;

        const payload = {
          wakeId: crypto.randomUUID(),
          reason: wake.primaryReason ?? 'market monitor',
          eventIds: wake.eventIds,
          priority: 'normal',
          requestedAt: new Date().toISOString(),
          source: wake.primarySource ?? wake.source,
          ...(wake.primaryContext !== undefined && { context: wake.primaryContext }),
        } as AgentWakePayload;

        await publisher.emitAgentWake(wake.agentId, payload);
        await redis.set(lastWakeKey, String(now), 'PX', sourceCooldownMs);

        // Phase 3: Delete the claimed bucket only if its generation hasn't
        // advanced since we claimed it. A higher generation means a new enqueue
        // arrived during publish and the bucket must be preserved.
        await withWakeMutationLock(async () => {
          const currentRaw = await redis.get(key);
          if (!currentRaw) return;
          try {
            const current = JSON.parse(currentRaw) as PendingWake;
            if ((current.generation ?? 0) !== (wake.generation ?? 0)) {
              return;
            }
          } catch { /* malformed — safe to delete */ }
          await redis.del(key);
        });

        metrics.wakeRequestsEmitted++;
        logger.debug({ agentId: wake.agentId, eventCount: wake.eventIds.length }, 'Wake signal emitted');
      }
    } finally {
      wakeFlushInFlight = false;
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  async function scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async function getLatestPrices(watches: WatchEntry[]): Promise<Map<string, { priceUsd: number; source: string; stale: boolean }>> {
    const priceMap = new Map<string, { priceUsd: number; source: string; stale: boolean }>();

    // Try to get prices from shared discovery snapshot first
    const snapshotRaw = await redis.get('market-intel:discovery:latest');
    if (snapshotRaw) {
      try {
        const snapshot = JSON.parse(snapshotRaw) as {
          freshness: { state: string };
          tokens: Array<{ network: string; address: string; symbol: string; priceUsd: number }>;
        };
        const isStale = snapshot.freshness?.state !== 'fresh';
        for (const token of snapshot.tokens ?? []) {
          priceMap.set(`${token.network}:${token.symbol}`, { priceUsd: token.priceUsd, source: 'discovery_snapshot', stale: isStale });
          priceMap.set(`${token.network}:${token.address}`, { priceUsd: token.priceUsd, source: 'discovery_snapshot', stale: isStale });
        }
      } catch { /* ignore parse errors */ }
    }

    // For watches not found in discovery snapshot, check regime (for perp symbols)
    for (const watch of watches) {
      const effectiveChain = watch.resolvedChain ?? watch.chain;
      const effectiveSymbol = watch.resolvedSymbol ?? watch.symbol;
      const key = `${effectiveChain}:${effectiveSymbol}`;
      if (priceMap.has(key)) continue;

      // Try regime snapshot for benchmark symbols (use effective symbol for pinned watches)
      let regimeRaw = await redis.get(`market-intel:regime:${effectiveSymbol}`);
      if (!regimeRaw && effectiveSymbol !== watch.symbol) {
        regimeRaw = await redis.get(`market-intel:regime:${watch.symbol}`);
      }
      if (regimeRaw) {
        try {
          const regime = JSON.parse(regimeRaw) as { details: { currentPrice?: number }; freshness?: { state: string } };
          if (regime.details?.currentPrice) {
            priceMap.set(key, {
              priceUsd: regime.details.currentPrice,
              source: 'regime_snapshot',
              stale: regime.freshness?.state !== 'fresh',
            });
          }
        } catch { /* ignore */ }
      }
    }

    return priceMap;
  }

  async function getActiveAgentIds(): Promise<string[]> {
    // Target only agents that have active watches (expressed interest in market data)
    const watchKeys = await scanKeys('agent:watches:*');
    return watchKeys
      .map((k) => k.replace('agent:watches:', ''))
      .filter((id) => !id.startsWith('summary:'));
  }

  async function checkDedupe(dedupeKey: string, _cooldownMs: number): Promise<boolean> {
    const fullKey = `market-monitor:dedupe:${dedupeKey}`;
    const exists = await redis.exists(fullKey);
    return exists === 1;
  }

  async function recordDedupe(dedupeKey: string, cooldownMs?: number): Promise<void> {
    const fullKey = `market-monitor:dedupe:${dedupeKey}`;
    if (cooldownMs && cooldownMs > 0) {
      await redis.set(fullKey, '1', 'PX', cooldownMs);
    } else {
      // For watch thresholds without time cooldown, the dedupe expires when watch state resets
      // Use a long TTL that covers normal watch lifetime
      await redis.set(fullKey, '1', 'EX', 86400);
    }
  }

  async function checkRateLimit(agentId: string, family: string): Promise<boolean> {
    const key = `market-monitor:rate:${agentId}:${family}`;
    const countRaw = await redis.get(key);
    if (!countRaw) return false;
    return Number(countRaw) >= MAX_EVENTS_PER_AGENT_PER_MINUTE;
  }

  async function incrementRateCounter(agentId: string, family: string): Promise<void> {
    const key = `market-monitor:rate:${agentId}:${family}`;
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 60);
    await pipeline.exec();
  }

  return { start, stop, evaluate, flushWakes: flushPendingWakes, getMetrics: () => ({ ...metrics }) };
}
