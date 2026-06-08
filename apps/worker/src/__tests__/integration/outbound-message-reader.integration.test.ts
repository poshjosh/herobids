/**
 * Worker integration test: outbound read does not starve queued heartbeats on the shared Redis connection.
 *
 * Requires REDIS_URL. Skipped otherwise.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import crypto from 'node:crypto';
import { OUTBOUND_READ_BLOCK_MS, readOutboundMessages } from '../../agents/outbound-message-reader.js';

const SKIP = !process.env['REDIS_URL'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port || '6379', 10),
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    ...(parsed.username && { username: decodeURIComponent(parsed.username) }),
  };
}

describe.skipIf(SKIP)('Worker: outbound message reader integration', () => {
  const redis = new Redis(parseRedisUrl(REDIS_URL));
  const createdStreams: string[] = [];

  afterEach(async () => {
    while (createdStreams.length > 0) {
      const streamKey = createdStreams.pop();
      if (streamKey) {
        await redis.del(streamKey).catch(() => { /* ignore */ });
      }
    }
  });

  it('releases the shared connection after the block timeout so a queued xadd can complete', async () => {
    const streamKey = `agent:outbound:${crypto.randomUUID()}`;
    createdStreams.push(streamKey);

    const readPromise = readOutboundMessages(redis, {
      outboundStream: streamKey,
      consumerGroup: 'agent-runtime',
      consumerName: `consumer-${crypto.randomUUID()}`,
      blockMs: OUTBOUND_READ_BLOCK_MS,
      count: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const xaddPromise = redis.xadd(streamKey, '*', 'envelope', JSON.stringify({ messageId: crypto.randomUUID() }));

    const timeoutMs = OUTBOUND_READ_BLOCK_MS + 3000;
    const outcome = await Promise.race([
      Promise.all([readPromise, xaddPromise]).then(([messages, streamId]) => ({
        messages,
        streamId,
        elapsedMs: Date.now() - startedAt,
      })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for shared Redis connection to unblock after ${timeoutMs}ms`)), timeoutMs)),
    ]);

    expect(outcome.messages).toEqual([]);
    expect(outcome.streamId).toMatch(/^\d+-\d+$/);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(OUTBOUND_READ_BLOCK_MS - 250);
    expect(outcome.elapsedMs).toBeLessThan(timeoutMs);
  });
});