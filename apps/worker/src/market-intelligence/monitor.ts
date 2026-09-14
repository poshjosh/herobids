import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';
import { scannerGatedKey } from '../redis-keys.js';
import crypto from 'node:crypto';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import type {
  MarketWatchTriggeredPayload,
  MarketDiscoveryDetectedPayload,
  MarketRegimeChangedPayload,
  AgentWakePayload,
  AgentWakeSource,
  WatchThresholdWakeContext,
  WatchPurpose,
  DiscoveryDeltaWakeContext,
  RegimeChangeWakeContext,
} from '@herobids/domain';

const logger = createLogger('market-monitor');

/**
 * A watch that crossed its threshold (false→true edge), as returned by the
 * Traderton boundary `check_watches` and consumed by the wake machinery.
 *
 * Structurally a subset of the boundary's `WatchEntry & { currentPrice,
 * priceSource, stale }` triggered-entry shape — the fields the monitor reads
 * to dedupe, rate-limit, build the payload, and enqueue the wake. Evaluation
 * authority lives in Traderton (B3); the monitor only delivers.
 */
export interface TriggeredWatch {
  watchId: string;
  symbol: string;
  chain: string;
  condition: 'above' | 'below';
  thresholdPrice: number;
  currentPrice: number;
  priceSource: string;
  stale: boolean;
  note?: string;
  purpose?: WatchPurpose;
  instrument?: { venue?: string; instrumentId?: string };
  coverage?: { positionKey?: string };
  schemaVersion?: number;
  resolvedSymbol?: string;
  resolvedChain?: string;
}

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
  /**
   * Delivery mode for this wake source.
   * - `wake`: emit event + enqueue wake bucket (default, backward-compatible)
   * - `batched`: emit event + enqueue wake bucket; the per-source cooldown
   *   mechanism already defers the wake emit until the source becomes eligible
   * - `context`: emit event only; do NOT enqueue `agent.wake` — the runtime
   *   records it as pending market context
   */
  mode?: 'wake' | 'batched' | 'context';
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

// ---------------------------------------------------------------------------
// 004 — Scanner-gated agent detection (standalone for testability)
// ---------------------------------------------------------------------------

/**
 * Check whether an agent is in scanner_gated hybrid mode by reading its
 * Redis flag. The agent container writes this flag on startup and cleans
 * it on shutdown.
 *
 * Uses {@link scannerGatedKey} to stay in sync with the agent write side.
 * Fails open (returns false) on Redis errors — the worst case is that the
 * agent receives non-scanner wakes, never that scanner wakes are blocked.
 */
export async function isAgentScannerGated(
  redis: Pick<Redis, 'get'>,
  agentId: string,
): Promise<boolean> {
  try {
    const flag = await redis.get(scannerGatedKey(agentId));
    return flag === '1';
  } catch {
    return false;
  }
}

export interface MonitorDeps {
  redis: Redis;
  publisher: InstanceEventPublisher;
  /** Evaluate an agent's watches over the Traderton boundary (check_watches).
   *  Returns the edge-up triggered watches + edge-down reset watchIds. Undefined
   *  when the boundary is unconfigured — evaluateWatches then no-ops (watch wakes
   *  require the boundary; in-process eval was removed in B3). */
  evaluateAgentWatches?: (agentId: string) => Promise<{ triggered: TriggeredWatch[]; reset: string[] }>;
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

  /** Resolve delivery mode for a wake source. Defaults to 'wake' (backward-compatible). */
  function getWakeMode(source: AgentWakeSource): 'wake' | 'batched' | 'context' {
    return config.wakePolicy?.[source]?.mode ?? 'wake';
  }

  /** 004: Check whether an agent is in scanner_gated hybrid mode.
   *  Delegates to the standalone {@link isAgentScannerGated} for testability. */
  async function checkScannerGated(agentId: string): Promise<boolean> {
    return isAgentScannerGated(redis, agentId);
  }
  const families = {
    watchThresholds: config.families?.watchThresholds ?? true,
    discoveryDeltas: config.families?.discoveryDeltas ?? true,
    regimeChanges: config.families?.regimeChanges ?? true,
  };
  const { redis, publisher, evaluateAgentWatches } = deps;

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

  async function evaluateWatches(): Promise<void> {
    if (stopped) return;
    // Evaluation authority for watches lives in Traderton (B3). Without the
    // boundary port there is no source of triggered/reset watches — no-op.
    if (!evaluateAgentWatches) return;

    // Active + subscribed to watch_threshold (folds in agent:sessions:active +
    // agent:wake:prefs). Stopped/crashed agents and agents that opted out are
    // excluded here, so the per-agent loop below only delivers to recipients.
    const agentIds = await getSubscribedAgentIds('watch_threshold');
    if (stopped) return;

    // 004: Pre-compute scanner_gated agents so we can switch to context-only
    // delivery inside the per-watch loop without redundant Redis calls
    // (mirrors evaluateDiscoveryDeltas / evaluateRegimeChanges).
    const scannerGatedAgentIds = new Set<string>();
    for (const agentId of agentIds) {
      if (await checkScannerGated(agentId)) {
        scannerGatedAgentIds.add(agentId);
      }
    }

    for (const agentId of agentIds) {
      if (stopped) return;

      let result: { triggered: TriggeredWatch[]; reset: string[] };
      try {
        result = await evaluateAgentWatches(agentId);
      } catch (err) {
        // Fail open per agent: a boundary error for one agent must not block others.
        logger.warn({ err, agentId }, 'evaluateAgentWatches failed for agent — skipping this cycle');
        continue;
      }

      // RESET: clear the platform wake-dedupe key for each edge-down watch so a
      // re-cross isn't suppressed (parity with main, which del'd
      // `market-monitor:dedupe:watch:{watchId}:cross:{condition}` on reset). The
      // reset list carries only watchId (not condition), so clear BOTH the
      // cross:above and cross:below keys — harmless if absent.
      for (const watchId of result.reset) {
        try {
          await redis.del(`market-monitor:dedupe:watch:${watchId}:cross:above`);
          await redis.del(`market-monitor:dedupe:watch:${watchId}:cross:below`);
        } catch (err) {
          // A persistently failing del would silently suppress future re-cross
          // wakes (the dedupe key never clears). Log it — parity with main,
          // where the del error propagated to evaluate()'s catch. Continue so
          // one bad key doesn't block the rest of the agent's triggered set.
          logger.warn({ err, agentId, watchId }, 'Failed to clear watch dedupe key on reset');
        }
      }

      const agentScannerGated = scannerGatedAgentIds.has(agentId);

      // TRIGGERED: run the platform wake machinery per entry —
      // dedupe → rate-limit → emit → enqueue. Only the SOURCE of triggered
      // watches changed (boundary instead of local price eval); the delivery
      // logic below is unchanged from main.
      for (const w of result.triggered) {
        if (stopped) return;
        const effectiveSymbol = w.resolvedSymbol ?? w.symbol;
        const effectiveChain = w.resolvedChain ?? w.chain;

        // Check dedupe
        const dedupeKey = `watch:${w.watchId}:cross:${w.condition}`;
        const suppressed = await checkDedupe(dedupeKey, 0); // No time-based cooldown for watches
        if (suppressed) { metrics.eventsSuppressed++; continue; }

        // Check rate limit
        const rateLimited = await checkRateLimit(agentId, 'watch_threshold');
        if (rateLimited) { metrics.eventsSuppressed++; continue; }

        const eventId = crypto.randomUUID();
        const payload: MarketWatchTriggeredPayload = {
          eventId,
          monitorType: 'watch_threshold',
          watchId: w.watchId,
          symbol: effectiveSymbol,
          chain: effectiveChain,
          condition: w.condition,
          thresholdPrice: w.thresholdPrice,
          currentPrice: w.currentPrice,
          priceSource: w.priceSource,
          stale: w.stale,
          ...(w.note ? { note: w.note } : {}),
          triggeredAt: new Date().toISOString(),
          ...(w.purpose ? { purpose: w.purpose } : {}),
          ...(w.instrument?.venue ? { instrumentVenue: w.instrument.venue } : {}),
          ...(w.instrument?.instrumentId ? { instrumentId: w.instrument.instrumentId } : {}),
          ...(w.coverage?.positionKey ? { positionKey: w.coverage.positionKey } : {}),
          ...(w.schemaVersion ? { schemaVersion: w.schemaVersion } : {}),
        };

        await publisher.emitMarketWatchTriggered(agentId, payload);
        await recordDedupe(dedupeKey);
        await incrementRateCounter(agentId, 'watch_threshold');
        const watchWakeMode = getWakeMode('watch_threshold');
        // context mode: emit the event to the outbound stream but do NOT
        // enqueue agent.wake — the runtime records it as pending context.
        // wake and batched modes both enqueue; the per-source cooldown
        // mechanism already defers batched wakes until eligibility.
        // 004: scanner_gated agents always get context-only delivery for
        // watch_threshold, consistent with discovery_delta and regime_change.
        const effectiveWatchMode = agentScannerGated ? 'context' : watchWakeMode;
        if (effectiveWatchMode !== 'context') {
          await enqueueWake(
            agentId,
            eventId,
            `${effectiveSymbol} crossed ${w.condition === 'above' ? 'above' : 'below'} ${w.thresholdPrice}`,
            'watch_threshold',
            {
              symbol: effectiveSymbol,
              chain: effectiveChain,
              condition: w.condition,
              thresholdPrice: w.thresholdPrice,
              currentPrice: w.currentPrice,
              stale: w.stale,
              triggeredAt: payload.triggeredAt,
              watchId: w.watchId,
              ...(w.note ? { note: w.note } : {}),
              ...(w.purpose ? { purpose: w.purpose } : {}),
              ...(w.instrument?.venue ? { instrumentVenue: w.instrument.venue } : {}),
              ...(w.instrument?.instrumentId ? { instrumentId: w.instrument.instrumentId } : {}),
              ...(w.coverage?.positionKey ? { positionKey: w.coverage.positionKey } : {}),
              ...(w.schemaVersion ? { schemaVersion: w.schemaVersion } : {}),
            },
          );
        }
        metrics.eventsEmitted++;
        logger.info({ agentId, watchId: w.watchId, symbol: effectiveSymbol, pinnedChain: effectiveChain }, 'Watch triggered');
      }
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

    // Get all agent IDs that are active and subscribed to discovery_delta
    const agentIds = await getSubscribedAgentIds('discovery_delta');
    if (stopped) return;

    // 004: Pre-compute scanner_gated agents so we can switch to context-only
    // delivery inside the per-token loops without redundant Redis calls.
    const scannerGatedAgentIds = new Set<string>();
    for (const agentId of agentIds) {
      if (await checkScannerGated(agentId)) {
        scannerGatedAgentIds.add(agentId);
      }
    }

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
          const ddWakeMode = getWakeMode('discovery_delta');
          // 004: scanner_gated agents always get context-only delivery for discovery
          const effectiveMode = scannerGatedAgentIds.has(agentId) ? 'context' : ddWakeMode;
          if (effectiveMode !== 'context') {
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
            const ddWakeMode = getWakeMode('discovery_delta');
            // 004: scanner_gated agents always get context-only delivery
            const effectiveMode = scannerGatedAgentIds.has(agentId) ? 'context' : ddWakeMode;
            if (effectiveMode !== 'context') {
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
            const ddWakeMode = getWakeMode('discovery_delta');
            // 004: scanner_gated agents always get context-only delivery
            const effectiveMode = scannerGatedAgentIds.has(agentId) ? 'context' : ddWakeMode;
            if (effectiveMode !== 'context') {
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

      const agentIds = await getSubscribedAgentIds('regime_change');
      if (stopped) return;

      // 004: Pre-compute scanner_gated agents so we can switch to context-only
      // delivery inside the per-agent loop without redundant Redis calls.
      const scannerGatedAgentIds = new Set<string>();
      for (const agentId of agentIds) {
        if (await checkScannerGated(agentId)) {
          scannerGatedAgentIds.add(agentId);
        }
      }

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
        const regimeWakeMode = getWakeMode('regime_change');
        // 004: scanner_gated agents always get context-only delivery for regime changes
        const effectiveMode = scannerGatedAgentIds.has(agentId) ? 'context' : regimeWakeMode;
        if (effectiveMode !== 'context') {
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

  /**
   * Get agent IDs that are both active (have a live session) AND subscribed to
   * the given monitor-owned wake source. Agents with no wake preferences key
   * (all sources) or with the source listed in subscribedSources are included.
   * Agents not in agent:sessions:active are excluded regardless of preferences.
   */
  async function getSubscribedAgentIds(source: AgentWakeSource): Promise<string[]> {
    const activeIds = await redis.smembers('agent:sessions:active');
    if (activeIds.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const agentId of activeIds) {
      pipeline.get(`agent:wake:prefs:${agentId}`);
    }
    const results = await pipeline.exec();

    const subscribed: string[] = [];
    for (let i = 0; i < activeIds.length; i++) {
      const agentId = activeIds[i]!;
      const raw = results?.[i]?.[1] as string | null;
      if (raw === null) {
        // No prefs key → agent receives all sources
        subscribed.push(agentId);
        continue;
      }
      try {
        const prefs = JSON.parse(raw) as { subscribedSources?: AgentWakeSource[] };
        if (!prefs.subscribedSources || prefs.subscribedSources.includes(source)) {
          subscribed.push(agentId);
        }
      } catch {
        // Malformed JSON → treat as all sources (safety)
        subscribed.push(agentId);
      }
    }
    return subscribed;
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
