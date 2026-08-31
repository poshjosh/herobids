import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDiskStats, checkPostgres, checkRedis, getRunningSessionCount, parseAppVersion } from './admin-utils.js';

/**
 * Mock `node:fs` so we can control `statfsSync` and `readFileSync` in ESM
 * (namespace properties of native ESM modules are non-configurable).
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statfsSync: vi.fn(actual.statfsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const fs = await import('node:fs');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getDiskStats
// ---------------------------------------------------------------------------

describe('getDiskStats', () => {

  it('returns disk stats when statfsSync succeeds', () => {
    vi.mocked(fs.statfsSync).mockReturnValue({
      blocks: 2000,
      bsize: 4096,
      bfree: 500,
      bavail: 400,
      files: 0,
      ffree: 0,
      type: 0,
    } as unknown as fs.StatsFsResult);

    const result = getDiskStats();
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBe(2000 * 4096);
    expect(result!.freeBytes).toBe(500 * 4096);
    expect(result!.usedBytes).toBe((2000 - 500) * 4096);
  });

  it('returns null when statfsSync throws', () => {
    vi.mocked(fs.statfsSync).mockImplementation(() => {
      throw new Error('not supported');
    });

    expect(getDiskStats()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkPostgres
// ---------------------------------------------------------------------------

describe('checkPostgres', () => {
  it('returns ok when the query succeeds', async () => {
    const db = { execute: vi.fn().mockResolvedValue([]) } as never;
    const result = await checkPostgres(db);
    expect(result).toBe('ok');
  });

  it('returns error when the query throws', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('connection refused')) } as never;
    const result = await checkPostgres(db);
    expect(result).toBe('error');
  });

  it('returns timeout when the query takes too long', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<void>(() => {});
    const db = { execute: vi.fn().mockReturnValue(neverResolves) } as never;

    const resultPromise = checkPostgres(db);

    // Advance past the 1500ms timeout.
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toBe('timeout');

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// checkRedis
// ---------------------------------------------------------------------------

describe('checkRedis', () => {
  it('returns ok when ping succeeds', async () => {
    const redis = { ping: vi.fn().mockResolvedValue('PONG') };
    const result = await checkRedis(redis);
    expect(result).toBe('ok');
  });

  it('returns error when ping throws', async () => {
    const redis = { ping: vi.fn().mockRejectedValue(new Error('connection reset')) };
    const result = await checkRedis(redis);
    expect(result).toBe('error');
  });

  it('returns timeout when ping takes too long', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<string>(() => {});
    const redis = { ping: vi.fn().mockReturnValue(neverResolves) };

    const resultPromise = checkRedis(redis);

    // Advance past the 1500ms timeout.
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toBe('timeout');

    vi.useRealTimers();
  });
});


// ---------------------------------------------------------------------------
// getRunningSessionCount
// ---------------------------------------------------------------------------

describe('getRunningSessionCount', () => {
  it('returns the count from the query result', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ n: 7 }]),
        }),
      }),
    } as never;

    const result = await getRunningSessionCount(db);
    expect(result).toBe(7);
  });

  it('returns 0 when no rows match', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as never;

    const result = await getRunningSessionCount(db);
    expect(result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseAppVersion
// ---------------------------------------------------------------------------

describe('parseAppVersion', () => {
  it('returns the version when a candidate file exists and is valid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: '1.2.3' }));

    const result = parseAppVersion();
    expect(result).toBe('1.2.3');
  });

  it("returns 'parse-failed' when all candidates fail", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = parseAppVersion();
    expect(result).toBe('parse-failed');
  });
});
