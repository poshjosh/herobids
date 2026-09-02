import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OUTBOUND_READ_BLOCK_MS, OUTBOUND_READ_TIMEOUT_MS, readOutboundMessages } from './outbound-message-reader.js';

describe('readOutboundMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a finite block timeout and acknowledges parsed messages', async () => {
    const xgroup = vi.fn().mockResolvedValue(undefined);
    const xreadgroup = vi.fn().mockResolvedValue([
      ['agent:outbound:agent-1', [
        ['msg-1', ['envelope', JSON.stringify({ messageId: 'm-1', type: 'instance.status' })]],
      ]],
    ]);
    const xack = vi.fn().mockResolvedValue(1);
    const redis = { xgroup, xreadgroup, xack } as any;

    const messages = await readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
      maxDrain: 50,
    });

    expect(xreadgroup).toHaveBeenCalledWith(
      'GROUP', 'agent-runtime', 'agent-1-123',
      'COUNT', 50,
      'BLOCK', OUTBOUND_READ_BLOCK_MS,
      'STREAMS', 'agent:outbound:agent-1', '>',
    );
    expect(xack).toHaveBeenCalledWith('agent:outbound:agent-1', 'agent-runtime', 'msg-1');
    expect(messages).toEqual([{ messageId: 'm-1', type: 'instance.status' }]);
  });

  it('defaults COUNT to a large drain cap so backlog is caught up in one read', async () => {
    const xgroup = vi.fn().mockResolvedValue(undefined);
    const xreadgroup = vi.fn().mockResolvedValue(null);
    const redis = { xgroup, xreadgroup, xack: vi.fn().mockResolvedValue(1) } as any;

    await readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    });

    // No explicit maxDrain → default (200), a single blocking read (one round-trip).
    expect(xreadgroup).toHaveBeenCalledTimes(1);
    expect(xreadgroup).toHaveBeenCalledWith(
      'GROUP', 'agent-runtime', 'agent-1-123',
      'COUNT', 200,
      'BLOCK', OUTBOUND_READ_BLOCK_MS,
      'STREAMS', 'agent:outbound:agent-1', '>',
    );
  });

  it('drains and acknowledges an entire backlog batch in one read', async () => {
    const xgroup = vi.fn().mockResolvedValue(undefined);
    const entries = Array.from({ length: 25 }, (_, i) => [
      `msg-${i}`, ['envelope', JSON.stringify({ messageId: `m-${i}`, type: i === 12 ? 'user.message' : 'instance.status' })],
    ]);
    const xreadgroup = vi.fn().mockResolvedValue([['agent:outbound:agent-1', entries]]);
    const xack = vi.fn().mockResolvedValue(1);
    const redis = { xgroup, xreadgroup, xack } as any;

    const messages = await readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
      maxDrain: 200,
    });

    // All 25 backlog entries are read + acked in a single tick, and the buried
    // user.message (index 12) is surfaced — not left behind for a later tick.
    expect(messages).toHaveLength(25);
    expect(messages.some((m) => m['type'] === 'user.message')).toBe(true);
    expect(xack).toHaveBeenCalledTimes(25);
  });

  it('returns an empty list when Redis yields no entries', async () => {
    const redis = {
      xgroup: vi.fn().mockResolvedValue(undefined),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    })).resolves.toEqual([]);
  });

  it('surfaces Redis read failures to the runtime loop', async () => {
    const redis = {
      xgroup: vi.fn().mockResolvedValue(undefined),
      xreadgroup: vi.fn().mockRejectedValue(new Error('Connection is closed')),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    })).rejects.toThrow('Connection is closed');
  });

  // --- Regression tests for Bug 004: BLOCK 0 caused heartbeat starvation ---

  it('OUTBOUND_READ_BLOCK_MS is a finite positive value (not 0) to prevent indefinite connection blocking', () => {
    expect(OUTBOUND_READ_BLOCK_MS).toBeGreaterThan(0);
    expect(Number.isFinite(OUTBOUND_READ_BLOCK_MS)).toBe(true);
  });

  it('OUTBOUND_READ_BLOCK_MS is less than OUTBOUND_READ_TIMEOUT_MS so Promise.race resolves after the blocking read returns', () => {
    // If BLOCK_MS >= TIMEOUT_MS the race guard would fire before xreadgroup returns,
    // leaving the connection held and re-creating the heartbeat starvation bug.
    expect(OUTBOUND_READ_BLOCK_MS).toBeLessThan(OUTBOUND_READ_TIMEOUT_MS);
  });

  it('wraps non-Error thrown values as Error so callers can rely on instanceof checks', async () => {
    const redis = {
      xgroup: vi.fn().mockResolvedValue(undefined),
      // Simulate a case where something non-Error is thrown (e.g. raw string rejection)
      xreadgroup: vi.fn().mockRejectedValue('LOADING Redis is loading'),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(redis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    })).rejects.toBeInstanceOf(Error);
  });

  it('ignores BUSYGROUP xgroup error but rethrows other xgroup errors', async () => {
    const busyGroupRedis = {
      xgroup: vi.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(busyGroupRedis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    })).resolves.toEqual([]);

    const otherErrorRedis = {
      xgroup: vi.fn().mockRejectedValue(new Error('NOPERM no permissions')),
      xreadgroup: vi.fn().mockResolvedValue(null),
      xack: vi.fn().mockResolvedValue(1),
    } as any;

    await expect(readOutboundMessages(otherErrorRedis, {
      outboundStream: 'agent:outbound:agent-1',
      consumerGroup: 'agent-runtime',
      consumerName: 'agent-1-123',
      blockMs: OUTBOUND_READ_BLOCK_MS,
    })).rejects.toThrow('NOPERM no permissions');
  });
});