/**
 * Cross-scan circuit breaker for candle fetch failures.
 *
 * After a symbol fails EVERY retry across failScansBeforeOpen consecutive scans,
 * the breaker opens and skips the symbol for a number of scan cycles (not milliseconds).
 * Skip duration grows exponentially: baseSkipScans × 2^(timesOpened) capped at maxSkipScans.
 *
 * Breaker state is stored in Redis keyed by agentId + providerSymbol so it
 * survives worker restarts.
 */

import { candleBreakerKey } from './redis-keys.js';

export interface BreakerConfig {
  /** Number of consecutive fully-failed scans before opening the breaker. */
  failScansBeforeOpen: number;
  /** Base number of scan cycles to skip when the breaker first opens. */
  baseSkipScans: number;
  /** Ceiling on skip duration in scan cycles. */
  maxSkipScans: number;
  /** TTL in seconds for breaker state stored in Redis. Defaults to 86400 (24h). */
  breakerStateTtlSeconds?: number;
}

interface BreakerState {
  failCount: number;
  /** Scan epoch until which this symbol should be skipped. null = breaker closed. */
  skipUntilScanEpoch: number | null;
  /** Number of times the breaker has previously opened (for exponential backoff). */
  timesOpened: number;
}

/** Minimal Redis interface used by the breaker — only GET/SET/DEL. */
export interface BreakerRedisStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryFlag: string, ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

export class CandleFetchBreaker {
  private readonly redis: BreakerRedisStore;
  private readonly config: BreakerConfig;

  constructor(redis: BreakerRedisStore, config: BreakerConfig) {
    this.redis = redis;
    this.config = config;
  }

  /** Check if this symbol should be skipped for the current scan. */
  async shouldSkip(agentId: string, symbol: string, currentScanEpoch: number): Promise<boolean> {
    const key = candleBreakerKey(agentId, symbol);
    const raw = await this.redis.get(key);
    if (!raw) return false;

    try {
      const state = JSON.parse(raw) as BreakerState;
      if (state.skipUntilScanEpoch != null && state.skipUntilScanEpoch > currentScanEpoch) {
        return true;
      }
      // Breaker has expired — the record will be cleaned up on next success/failure
      return false;
    } catch {
      // Corrupt state — treat as closed
      return false;
    }
  }

  /** Reset fail count and close the breaker for this symbol. */
  async recordSuccess(agentId: string, symbol: string): Promise<void> {
    const key = candleBreakerKey(agentId, symbol);
    await this.redis.del(key);
  }

  /**
   * Record a fully-failed scan for this symbol (all retries exhausted).
   * Increments failCount; opens the breaker when >= failScansBeforeOpen.
   */
  async recordFailure(agentId: string, symbol: string, currentScanEpoch: number): Promise<void> {
    const { failScansBeforeOpen, baseSkipScans, maxSkipScans } = this.config;
    const key = candleBreakerKey(agentId, symbol);

    const raw = await this.redis.get(key);
    let state: BreakerState;
    try {
      state = raw ? (JSON.parse(raw) as BreakerState) : { failCount: 0, skipUntilScanEpoch: null, timesOpened: 0 };
    } catch {
      state = { failCount: 0, skipUntilScanEpoch: null, timesOpened: 0 };
    }

    state.failCount++;

    if (state.failCount >= failScansBeforeOpen) {
      const skipDuration = Math.min(
        baseSkipScans * Math.pow(2, state.timesOpened),
        maxSkipScans,
      );
      state.skipUntilScanEpoch = currentScanEpoch + skipDuration;
      state.timesOpened++;
      state.failCount = 0; // reset after opening
    }

    const ttlSeconds = this.config.breakerStateTtlSeconds ?? 86400;
    await this.redis.set(key, JSON.stringify(state), 'EX', ttlSeconds);
  }
}
