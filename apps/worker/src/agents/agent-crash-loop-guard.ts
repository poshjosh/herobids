import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-crash-loop-guard');

export interface CrashLoopGuardConfig {
  enabled: boolean;
  maxCrashesInWindow: number;
  windowMs: number;
}

export interface CrashRecordResult {
  crashCount: number;
  blocked: boolean;
}

function crashEventsKey(agentId: string): string {
  return `agent:crash:events:${agentId}`;
}

function crashAlertedKey(agentId: string): string {
  return `agent:crash:alerted:${agentId}`;
}

/**
 * Record a crash event for the given agent and return the current in-window
 * crash count + whether the agent is now blocked from relaunch.
 *
 * Uses a Redis ZSET keyed by agentId:
 *   - key:   `agent:crash:events:<agentId>`
 *   - member: `sessionId` when known, else `nosession:<nowMs>`
 *   - score:  `nowMs`
 *
 * Deduplication: same session id → same ZSET member → no double count if both
 * terminal paths (onContainerDie + handleRuntimeSessionEnd) fire for one crash.
 */
export async function recordCrashEvent(
  redis: Redis,
  agentId: string,
  sessionId: string | undefined,
  cfg: CrashLoopGuardConfig,
  nowMs: number,
): Promise<CrashRecordResult> {
  const key = crashEventsKey(agentId);
  const member = sessionId ? sessionId : `nosession:${nowMs}`;
  const cutoff = nowMs - cfg.windowMs;

  try {
    // 1. Add the crash event (idempotent by member)
    await redis.zadd(key, nowMs, member);

    // 2. Prune entries older than the window
    await redis.zremrangebyscore(key, '-inf', cutoff);

    // 3. Count remaining in-window entries
    const crashCount = await redis.zcard(key);

    // 4. Set TTL so the key self-cleans after the window (renew on each write)
    await redis.pexpire(key, cfg.windowMs);

    const blocked = crashCount >= cfg.maxCrashesInWindow;
    logger.info(
      { agentId, sessionId, crashCount, maxCrashes: cfg.maxCrashesInWindow, blocked },
      'Recorded agent crash event',
    );

    return { crashCount, blocked };
  } catch (err) {
    logger.warn({ err, agentId, sessionId }, 'Failed to record crash event — assuming not blocked');
    return { crashCount: 0, blocked: false };
  }
}

/**
 * Read-only check: is the agent currently blocked from launch due to
 * repeated crashes within the sliding window?
 *
 * Prunes expired entries, counts remaining, and compares against threshold.
 * Auto-unblock: once no crash occurs for `windowMs` the ZCARD falls below
 * the threshold and launches are permitted again automatically.
 */
export async function isCrashLaunchBlocked(
  redis: Redis,
  agentId: string,
  cfg: CrashLoopGuardConfig,
  nowMs: number,
): Promise<boolean> {
  if (!cfg.enabled) return false;

  const key = crashEventsKey(agentId);
  const cutoff = nowMs - cfg.windowMs;

  try {
    // Prune entries older than the window
    await redis.zremrangebyscore(key, '-inf', cutoff);

    // Ensure the key self-cleans even if recordCrashEvent is never called again
    await redis.pexpire(key, cfg.windowMs);

    // Count remaining entries
    const crashCount = await redis.zcard(key);

    const blocked = crashCount >= cfg.maxCrashesInWindow;
    if (blocked) {
      logger.info({ agentId, crashCount, maxCrashes: cfg.maxCrashesInWindow }, 'Agent crash-launch blocked');
    }

    return blocked;
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to check crash-launch block — assuming not blocked');
    return false;
  }
}

/**
 * Atomically check if a crash-loop alert should fire for this agent.
 * Uses a Redis key with TTL to dedup alerts within the same window.
 * Returns true only on the first call within the window after the threshold is crossed.
 */
export async function shouldFireCrashLoopAlert(
  redis: Redis,
  agentId: string,
  windowMs: number,
): Promise<boolean> {
  const key = crashAlertedKey(agentId);
  try {
    // SET NX with TTL: returns 'OK' only if the key did not exist
    const result = await redis.set(key, '1', 'PX', windowMs, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to check crash-loop alert dedup — allowing alert');
    return true; // fail-open: better to double-alert than to miss one
  }
}
