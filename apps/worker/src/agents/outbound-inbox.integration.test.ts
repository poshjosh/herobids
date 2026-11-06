import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundInbox, type OutboundInboxOptions } from './outbound-inbox.js';

const REDIS_URL = process.env['OUTBOUND_INBOX_TEST_REDIS_URL'];

describe.skipIf(!REDIS_URL)('OutboundInbox against a real Redis', () => {
  let redis: Redis;
  let options: OutboundInboxOptions;

  beforeAll(() => {
    redis = new Redis(REDIS_URL!, { lazyConnect: false, maxRetriesPerRequest: 3 });
  });

  afterAll(async () => {
    await redis.quit();
  });

  function setup(name: string) {
    const token = `${name}:${Date.now()}`;
    options = {
      outboundStream: `test:outbound:${token}`,
      consumerGroup: 'agent-runtime',
      consumerName: 'process-1',
      handledKeyPrefix: `test:handled:${token}:`,
      handledTtlSeconds: 60,
      attemptsKey: `test:attempts:${token}`,
      deadLetterStream: `test:dead:${token}`,
      maxAttempts: 3,
      maxDrain: 50,
    };
  }

  async function publish(type: string, messageId: string) {
    await redis.xadd(options.outboundStream, '*', 'envelope', JSON.stringify({ type, messageId }));
  }

  function inboxFor(consumerName: string) {
    return new OutboundInbox(redis, { ...options, consumerName });
  }

  it('returns a discarded read again on the next fetch, with nothing lost', async () => {
    setup('discarded');
    await publish('user.message', 'u-discarded');
    const inbox = inboxFor('process-1');

    const discarded = await inbox.fetch(0);
    const retried = await inbox.fetch(0);

    expect(discarded.map((e) => e.envelope['messageId'])).toEqual(['u-discarded']);
    expect(retried.map((e) => e.envelope['messageId'])).toEqual(['u-discarded']);
  });

  it('acknowledges entries only when their tick completes, and not again afterwards', async () => {
    setup('completed');
    await publish('user.message', 'u-done');
    const inbox = inboxFor('process-1');

    inbox.handOff(await inbox.fetch(0));
    await inbox.completeTick('completed');

    expect(await inbox.fetch(0)).toEqual([]);
    expect((await redis.xpending(options.outboundStream, options.consumerGroup))[0]).toBe(0);
  });

  it('returns the entries again when the tick fails', async () => {
    setup('failed');
    await publish('user.message', 'u-retry');
    const inbox = inboxFor('process-1');

    inbox.handOff(await inbox.fetch(0));
    await inbox.completeTick('failed');

    expect((await inbox.fetch(0)).map((e) => e.envelope['messageId'])).toEqual(['u-retry']);
  });

  it('dead-letters an entry after maxAttempts failed ticks, and stops returning it', async () => {
    setup('poison');
    await publish('user.message', 'u-poison');
    const inbox = inboxFor('process-1');

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const entries = await inbox.fetch(0);
      expect(entries.map((e) => e.envelope['messageId'])).toEqual(['u-poison']);
      inbox.handOff(entries);
      await inbox.completeTick('failed');
    }

    expect(await inbox.fetch(0)).toEqual([]);
    const dead = await redis.xrange(options.deadLetterStream, '-', '+');
    expect(dead).toHaveLength(1);
    expect(dead[0]![1].some((field) => field.includes('u-poison'))).toBe(true);
  });

  it('a paused (held) hand-over is not marked handled, so a restart replays the message', async () => {
    setup('held-restart');
    await publish('user.message', 'u-held');
    const paused = inboxFor('process-old');

    paused.handOff(await paused.fetch(0));
    await paused.completeTick('held');
    // process-old dies while paused: the held entries were never acknowledged or marked.

    const restarted = inboxFor('process-new');
    await restarted.claimStalePending();
    const replayed = await restarted.fetch(0);

    expect(replayed.map((e) => e.envelope['messageId'])).toEqual(['u-held']);
    expect(await redis.exists(`${options.handledKeyPrefix}u-held`)).toBe(0);
  });

  it('a restart takes over entries of the previous consumer at once, and replays the unfinished ones only', async () => {
    setup('restart');
    await publish('user.message', 'u-completed');
    await publish('user.message', 'u-crashed');
    const before = inboxFor('process-old');
    const handed = await before.fetch(0);
    before.handOff(handed.slice(0, 1));
    await before.completeTick('completed');
    before.handOff(handed.slice(1));
    // process-old dies here: 'u-crashed' is never settled.

    const after = inboxFor('process-new');
    expect(await after.claimStalePending()).toBe(1);
    expect((await after.fetch(0)).map((e) => e.envelope['messageId'])).toEqual(['u-crashed']);
  });
});
