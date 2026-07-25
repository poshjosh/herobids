import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordCrashEvent, isCrashLaunchBlocked, shouldFireCrashLoopAlert } from './agent-crash-loop-guard.js';
import type { CrashLoopGuardConfig } from './agent-crash-loop-guard.js';

const AGENT_ID = 'agent-test-1';
const NOW = 1_750_000_000_000;

function makeConfig(overrides: Partial<CrashLoopGuardConfig> = {}): CrashLoopGuardConfig {
  return {
    enabled: true,
    maxCrashesInWindow: 3,
    windowMs: 300_000,
    ...overrides,
  };
}

function makeRedisMock() {
  return {
    zadd: vi.fn().mockResolvedValue(1),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(0),
    pexpire: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
  } as any;
}

// ── recordCrashEvent ────────────────────────────────────────────────────────

describe('recordCrashEvent', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let cfg: CrashLoopGuardConfig;

  beforeEach(() => {
    redis = makeRedisMock();
    cfg = makeConfig();
  });

  it('records a crash with the correct ZSET key and member (sessionId)', async () => {
    await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);

    expect(redis.zadd).toHaveBeenCalledWith(`agent:crash:events:${AGENT_ID}`, NOW, 'sess-1');
  });

  it('uses timestamp-based member when sessionId is undefined', async () => {
    await recordCrashEvent(redis, AGENT_ID, undefined, cfg, NOW);

    expect(redis.zadd).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      NOW,
      `nosession:${NOW}`,
    );
  });

  it('prunes entries older than the window', async () => {
    await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);

    const cutoff = NOW - cfg.windowMs;
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      '-inf',
      cutoff,
    );
  });

  it('returns crashCount and blocked status from zcard', async () => {
    redis.zcard.mockResolvedValue(3);

    const result = await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);

    expect(result).toEqual({ crashCount: 3, blocked: true });
  });

  it('returns not blocked when crashCount is below threshold', async () => {
    redis.zcard.mockResolvedValue(2);

    const result = await recordCrashEvent(redis, AGENT_ID, 'sess-2', cfg, NOW);

    expect(result).toEqual({ crashCount: 2, blocked: false });
  });

  it('detects block transition exactly at threshold', async () => {
    redis.zcard.mockResolvedValue(cfg.maxCrashesInWindow); // exactly 3

    const result = await recordCrashEvent(redis, AGENT_ID, 'sess-3', cfg, NOW);

    expect(result.blocked).toBe(true);
    expect(result.crashCount).toBe(cfg.maxCrashesInWindow);
  });

  it('sets TTL on the ZSET key', async () => {
    await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);

    expect(redis.pexpire).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      cfg.windowMs,
    );
  });

  it('duplicate session id counts once (ZADD idempotent by member)', async () => {
    // First call
    await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);
    // Second call — same sessionId → same ZADD member → no increment
    redis.zcard.mockResolvedValue(1);
    const result = await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW + 1000);

    expect(redis.zadd).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      NOW + 1000,
      'sess-1',
    );
    expect(result.crashCount).toBe(1);
    expect(result.blocked).toBe(false);
  });

  it('swallows errors and returns safe default', async () => {
    redis.zadd.mockRejectedValueOnce(new Error('Redis connection lost'));

    const result = await recordCrashEvent(redis, AGENT_ID, 'sess-1', cfg, NOW);

    expect(result).toEqual({ crashCount: 0, blocked: false });
  });

  it('multiple distinct sessions within window count up towards block', async () => {
    // Simulate zcard returning incrementing counts
    redis.zcard
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);

    const r1 = await recordCrashEvent(redis, AGENT_ID, 'sess-a', cfg, NOW);
    expect(r1).toEqual({ crashCount: 1, blocked: false });

    const r2 = await recordCrashEvent(redis, AGENT_ID, 'sess-b', cfg, NOW + 1000);
    expect(r2).toEqual({ crashCount: 2, blocked: false });

    const r3 = await recordCrashEvent(redis, AGENT_ID, 'sess-c', cfg, NOW + 2000);
    expect(r3).toEqual({ crashCount: 3, blocked: true });
  });
});

// ── isCrashLaunchBlocked ─────────────────────────────────────────────────────

describe('isCrashLaunchBlocked', () => {
  let redis: ReturnType<typeof makeRedisMock>;
  let cfg: CrashLoopGuardConfig;

  beforeEach(() => {
    redis = makeRedisMock();
    cfg = makeConfig();
  });

  it('returns false when guard is disabled', async () => {
    const result = await isCrashLaunchBlocked(redis, AGENT_ID, { ...cfg, enabled: false }, NOW);

    expect(result).toBe(false);
    expect(redis.zremrangebyscore).not.toHaveBeenCalled();
  });

  it('returns true when crashCount >= threshold', async () => {
    redis.zcard.mockResolvedValue(3);

    const result = await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    expect(result).toBe(true);
  });

  it('returns false when crashCount < threshold', async () => {
    redis.zcard.mockResolvedValue(2);

    const result = await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    expect(result).toBe(false);
  });

  it('prunes expired entries with correct cutoff', async () => {
    await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    const cutoff = NOW - cfg.windowMs;
    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      '-inf',
      cutoff,
    );
  });

  it('sets TTL on the ZSET key for self-cleanup', async () => {
    await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    expect(redis.pexpire).toHaveBeenCalledWith(
      `agent:crash:events:${AGENT_ID}`,
      cfg.windowMs,
    );
  });

  it('auto-unblocks after window when all entries expire', async () => {
    redis.zcard.mockResolvedValue(0);

    const result = await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    expect(result).toBe(false);
  });

  it('swallows errors and returns false (fail-safe)', async () => {
    redis.zcard.mockRejectedValueOnce(new Error('Redis connection lost'));

    const result = await isCrashLaunchBlocked(redis, AGENT_ID, cfg, NOW);

    expect(result).toBe(false);
  });
});

// ── shouldFireCrashLoopAlert ─────────────────────────────────────────────────

describe('shouldFireCrashLoopAlert', () => {
  let redis: ReturnType<typeof makeRedisMock>;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  it('returns true on first call within the window (SET NX succeeds)', async () => {
    redis.set.mockResolvedValue('OK');

    const result = await shouldFireCrashLoopAlert(redis, AGENT_ID, 300_000);

    expect(result).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      `agent:crash:alerted:${AGENT_ID}`,
      '1',
      'PX',
      300_000,
      'NX',
    );
  });

  it('returns false when alert was already fired within the window (SET NX returns null)', async () => {
    redis.set.mockResolvedValue(null);

    const result = await shouldFireCrashLoopAlert(redis, AGENT_ID, 300_000);

    expect(result).toBe(false);
  });

  it('returns true again after TTL expires (simulated key expiry)', async () => {
    // Simulate: first call → succeeded, key expired → second call succeeds again
    redis.set
      .mockResolvedValueOnce(null) // still exists
      .mockResolvedValueOnce('OK'); // expired, re-created

    const r1 = await shouldFireCrashLoopAlert(redis, AGENT_ID, 300_000);
    expect(r1).toBe(false);

    const r2 = await shouldFireCrashLoopAlert(redis, AGENT_ID, 300_000);
    expect(r2).toBe(true);
  });

  it('swallows errors and returns true (fail-open: better double-alert than miss)', async () => {
    redis.set.mockRejectedValueOnce(new Error('Redis connection lost'));

    const result = await shouldFireCrashLoopAlert(redis, AGENT_ID, 300_000);

    expect(result).toBe(true);
  });
});
