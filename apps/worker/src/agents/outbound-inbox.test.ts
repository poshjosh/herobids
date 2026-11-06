import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { compareStreamIds, OutboundInbox, readGroupLastDeliveredId, settleTick, tickOutcome, type OutboundEntry, type OutboundInboxOptions } from './outbound-inbox.js';

const OPTIONS: OutboundInboxOptions = {
  outboundStream: 'agent:outbound:a1',
  consumerGroup: 'agent-runtime',
  consumerName: 'agent-a1-1',
  handledKeyPrefix: 'agent:outbound-handled:a1:',
  handledTtlSeconds: 86400,
  attemptsKey: 'agent:outbound-attempts:a1',
  deadLetterStream: 'agent:outbound-dead:a1',
  maxAttempts: 3,
};

function envelope(type: string, messageId: string) {
  return JSON.stringify({ type, messageId });
}

function fakeRedis(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    xgroup: vi.fn().mockResolvedValue('OK'),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xack: vi.fn().mockResolvedValue(1),
    xpending: vi.fn().mockResolvedValue([]),
    xclaim: vi.fn().mockResolvedValue([]),
    xadd: vi.fn().mockResolvedValue('9-0'),
    set: vi.fn().mockResolvedValue('OK'),
    mget: vi.fn().mockImplementation(async (...keys: string[]) => keys.map(() => null)),
    hincrby: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    xinfo: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Redis & Record<string, ReturnType<typeof vi.fn>>;
}

function inbox(redis: Redis, maxDrain?: number) {
  return new OutboundInbox(redis, { ...OPTIONS, ...(maxDrain ? { maxDrain } : {}) });
}

function streamReply(items: Array<[string, string[] | null]>) {
  return [[OPTIONS.outboundStream, items]];
}

describe('OutboundInbox.fetch', () => {
  it('returns new entries without acknowledging them', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([]))
        .mockResolvedValueOnce(streamReply([['1-0', ['envelope', envelope('instance.status', 'm-1')]]])),
    });

    const entries = await inbox(redis).fetch(1500);

    expect(entries.map((e) => e.streamId)).toEqual(['1-0']);
    expect(redis.xack).not.toHaveBeenCalled();
  });

  it('reads pending entries first, and blocks on the new read only when nothing is pending', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([]))
        .mockResolvedValueOnce(streamReply([['2-0', ['envelope', envelope('instance.status', 'm-2')]]])),
    });

    await inbox(redis).fetch(1500);

    expect((redis.xreadgroup as ReturnType<typeof vi.fn>).mock.calls[0]).toContain('0');
    expect((redis.xreadgroup as ReturnType<typeof vi.fn>).mock.calls[1]).toContain('BLOCK');
  });

  it('does not block on the new read when pending entries were already returned', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([['1-0', ['envelope', envelope('instance.status', 'p-1')]]]))
        .mockResolvedValueOnce(null),
    });

    const entries = await inbox(redis).fetch(1500);

    expect(entries.map((e) => e.streamId)).toEqual(['1-0']);
    expect((redis.xreadgroup as ReturnType<typeof vi.fn>).mock.calls[1]).not.toContain('BLOCK');
  });

  it('returns an entry again on the next fetch when it was never handed over (a discarded read)', async () => {
    const pendingReply = streamReply([['1-0', ['envelope', envelope('user.message', 'u-1')]]]);
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(pendingReply).mockResolvedValueOnce(null)
        .mockResolvedValueOnce(pendingReply).mockResolvedValueOnce(null),
    });
    const ib = inbox(redis);

    expect((await ib.fetch(1500)).map((e) => e.streamId)).toEqual(['1-0']);
    expect((await ib.fetch(1500)).map((e) => e.streamId)).toEqual(['1-0']);
  });

  it('does not return an entry that has been handed over', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([['1-0', ['envelope', envelope('instance.status', 'm-1')]]]))
        .mockResolvedValueOnce(streamReply([['1-0', ['envelope', envelope('instance.status', 'm-1')]]]))
        .mockResolvedValueOnce(null),
    });
    const ib = inbox(redis);

    ib.handOff(await ib.fetch(1500));

    expect(await ib.fetch(0)).toEqual([]);
  });

  it('acknowledges malformed and deleted entries so they do not stay pending', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([['1-0', null], ['2-0', ['envelope', '{not json']]]))
        .mockResolvedValueOnce(null),
    });

    expect(await inbox(redis).fetch(1500)).toEqual([]);
    expect(redis.xack).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, '1-0', '2-0');
  });

  it('acknowledges a user message that a completed tick already handled, and does not return it', async () => {
    const redis = fakeRedis({
      xreadgroup: vi.fn()
        .mockResolvedValueOnce(streamReply([['3-0', ['envelope', envelope('user.message', 'u-9')]]]))
        .mockResolvedValueOnce(null),
      mget: vi.fn().mockResolvedValue(['1']),
    });

    expect(await inbox(redis).fetch(1500)).toEqual([]);
    expect(redis.mget).toHaveBeenCalledWith(`${OPTIONS.handledKeyPrefix}u-9`);
    expect(redis.xack).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, '3-0');
  });
});

describe('OutboundInbox.completeTick', () => {
  const userEntry: OutboundEntry = { streamId: '5-0', envelope: { type: 'user.message', messageId: 'u-5' } };
  const eventEntry: OutboundEntry = { streamId: '6-0', envelope: { type: 'market.discovery.detected' } };

  it('completed: marks handed user messages handled, then acknowledges every handed entry', async () => {
    const redis = fakeRedis();
    const ib = inbox(redis);
    ib.handOff([userEntry, eventEntry]);

    await ib.completeTick('completed');

    expect(redis.set).toHaveBeenCalledWith(`${OPTIONS.handledKeyPrefix}u-5`, '1', 'EX', 86400);
    expect(redis.xack).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, '5-0', '6-0');
  });

  it('held: keeps the handed entries in memory, with no marker and no acknowledgement', async () => {
    const redis = fakeRedis();
    const ib = inbox(redis);
    ib.handOff([userEntry]);

    await ib.completeTick('held');

    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.xack).not.toHaveBeenCalled();
    await ib.completeTick('completed');
    expect(redis.xack).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, '5-0');
  });

  it('failed: releases the entries without acknowledging them, and counts the attempt', async () => {
    const redis = fakeRedis();
    const ib = inbox(redis);
    ib.handOff([userEntry]);

    await ib.completeTick('failed');

    expect(redis.hincrby).toHaveBeenCalledWith(OPTIONS.attemptsKey, '5-0', 1);
    expect(redis.xack).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('failed: dead-letters an entry that reached the attempt limit, then acknowledges it', async () => {
    const redis = fakeRedis({ hincrby: vi.fn().mockResolvedValue(3) });
    const ib = inbox(redis);
    ib.handOff([userEntry]);

    await ib.completeTick('failed');

    expect(redis.xadd).toHaveBeenCalledWith(
      OPTIONS.deadLetterStream, 'MAXLEN', '~', 1000, '*',
      'envelope', expect.any(String), 'streamId', '5-0', 'reason', 'failed 3 ticks',
    );
    expect(redis.xack).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, '5-0');
  });

  it('leaves entries pending when the handled marker cannot be written', async () => {
    const redis = fakeRedis({ set: vi.fn().mockRejectedValue(new Error('redis down')) });
    const ib = inbox(redis);
    ib.handOff([userEntry]);

    await ib.completeTick('completed');

    expect(redis.xack).not.toHaveBeenCalled();
  });
});

describe('OutboundInbox.claimStalePending', () => {
  it('claims entries owned by other consumers, without any idle threshold, and acknowledges nothing', async () => {
    const redis = fakeRedis({
      xpending: vi.fn().mockResolvedValue([
        ['1-0', 'agent-a1-100', 2000, 1],
        ['2-0', 'agent-a1-1', 0, 1],
        ['3-0', 'agent-a1-99', 5000, 2],
      ]),
      xclaim: vi.fn().mockResolvedValue([['1-0', ['envelope', 'x']], null]),
    });

    const claimed = await inbox(redis).claimStalePending();

    expect(redis.xclaim).toHaveBeenCalledWith(OPTIONS.outboundStream, OPTIONS.consumerGroup, OPTIONS.consumerName, 0, '1-0', '3-0');
    expect(claimed).toBe(1);
    expect(redis.xack).not.toHaveBeenCalled();
  });
});

describe('tickOutcome', () => {
  it('holds a paused tick, whatever else happened in it', () => {
    expect(tickOutcome({ paused: true, failed: false })).toBe('held');
    expect(tickOutcome({ paused: true, failed: true })).toBe('held');
  });

  it('reports a failed active tick, including an LLM failure that did not throw', () => {
    expect(tickOutcome({ paused: false, failed: true })).toBe('failed');
  });

  it('reports a clean active tick as completed', () => {
    expect(tickOutcome({ paused: false, failed: false })).toBe('completed');
  });
});

describe('settleTick', () => {
  function recordingInbox() {
    const completeTick = vi.fn().mockResolvedValue(undefined);
    return { completeTick };
  }

  it('settles with the outcome the tick reports', async () => {
    for (const outcome of ['completed', 'failed', 'held'] as const) {
      const inboxStub = recordingInbox();
      await expect(settleTick(inboxStub, async () => outcome)).resolves.toBe(outcome);
      expect(inboxStub.completeTick).toHaveBeenCalledWith(outcome);
    }
  });

  it('settles a throwing tick as failed and rethrows', async () => {
    const inboxStub = recordingInbox();

    await expect(settleTick(inboxStub, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(inboxStub.completeTick).toHaveBeenCalledWith('failed');
  });
});

describe('readGroupLastDeliveredId', () => {
  it('returns the last-delivered-id of the named group', async () => {
    const redis = fakeRedis({
      xinfo: vi.fn().mockResolvedValue([
        ['name', 'agent-market-wake', 'consumers', 1, 'pending', 0, 'last-delivered-id', '1793961976032-0'],
        ['name', 'agent-runtime', 'consumers', 1, 'pending', 0, 'last-delivered-id', '1793961359958-0'],
      ]),
    });

    await expect(readGroupLastDeliveredId(redis, 's', 'agent-runtime')).resolves.toBe('1793961359958-0');
  });

  it('returns null when the group is absent or the read fails', async () => {
    await expect(readGroupLastDeliveredId(fakeRedis({ xinfo: vi.fn().mockResolvedValue([]) }), 's', 'agent-runtime')).resolves.toBeNull();
    await expect(readGroupLastDeliveredId(fakeRedis({ xinfo: vi.fn().mockRejectedValue(new Error('down')) }), 's', 'agent-runtime')).resolves.toBeNull();
  });
});

describe('compareStreamIds', () => {
  it('orders by milliseconds, then by sequence', () => {
    expect(compareStreamIds('1793960965106-0', '1793961359958-0')).toBeLessThan(0);
    expect(compareStreamIds('1793960965106-2', '1793960965106-10')).toBeLessThan(0);
    expect(compareStreamIds('1793960965106-0', '1793960965106-0')).toBe(0);
    expect(compareStreamIds('1793961359958-0', '1793960965106-0')).toBeGreaterThan(0);
  });
});
