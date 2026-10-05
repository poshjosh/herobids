// docs/features/2026/10/05/001-backend-tool-discovery-retry — bounded retry
// around a single `tools/list` discovery attempt.
import { describe, it, expect, vi } from 'vitest';
import { discoverWithRetry, type DiscoveryRetryOptions } from './discover-tools.js';
import type { ListToolsOutcome } from './transports/mcp-transport.js';

const OPTIONS: DiscoveryRetryOptions = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 };
const OK: ListToolsOutcome = { kind: 'ok', tools: [] };
const UNREACHABLE = (message: string): ListToolsOutcome => ({ kind: 'unreachable', message });

describe('discoverWithRetry', () => {
  it('returns immediately on first-attempt success without sleeping', async () => {
    const attempt = vi.fn().mockResolvedValue(OK);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await discoverWithRetry(attempt, OPTIONS, sleep);

    expect(result).toEqual(OK);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries after a transient failure and returns the eventual success', async () => {
    const attempt = vi.fn()
      .mockResolvedValueOnce(UNREACHABLE('timeout'))
      .mockResolvedValueOnce(OK);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await discoverWithRetry(attempt, OPTIONS, sleep);

    expect(result).toEqual(OK);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250); // baseDelayMs * 2^0
  });

  it('exhausts maxAttempts and returns the last unreachable outcome, never throwing', async () => {
    const attempt = vi.fn()
      .mockResolvedValueOnce(UNREACHABLE('first'))
      .mockResolvedValueOnce(UNREACHABLE('second'))
      .mockResolvedValueOnce(UNREACHABLE('third'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await discoverWithRetry(attempt, OPTIONS, sleep);

    expect(result).toEqual(UNREACHABLE('third'));
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the final attempt
  });

  it('doubles the delay each retry up to maxDelayMs', async () => {
    const attempt = vi.fn().mockResolvedValue(UNREACHABLE('down'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await discoverWithRetry(attempt, { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 1_200 }, sleep);

    expect(sleep).toHaveBeenNthCalledWith(1, 500);   // 500 * 2^0
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000);  // 500 * 2^1
    expect(sleep).toHaveBeenNthCalledWith(3, 1_200);  // 500 * 2^2 = 2000, capped to 1200
  });

  it('makes exactly one attempt when maxAttempts is 1 (retry disabled)', async () => {
    const attempt = vi.fn().mockResolvedValue(UNREACHABLE('down'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await discoverWithRetry(attempt, { maxAttempts: 1, baseDelayMs: 250, maxDelayMs: 2_000 }, sleep);

    expect(result).toEqual(UNREACHABLE('down'));
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses the real setTimeout-based sleep by default (no injected sleep)', async () => {
    const attempt = vi.fn().mockResolvedValue(OK);
    await expect(discoverWithRetry(attempt, OPTIONS)).resolves.toEqual(OK);
  });
});
