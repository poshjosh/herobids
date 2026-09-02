import type { Redis } from 'ioredis';

export const OUTBOUND_READ_BLOCK_MS = 1500;
export const OUTBOUND_READ_TIMEOUT_MS = 2000;

export interface OutboundMessageReaderOptions {
  outboundStream: string;
  consumerGroup: string;
  consumerName: string;
  blockMs: number;
  /**
   * Upper bound (COUNT) on how many messages a single tick drains in one read.
   * This prevents the runtime consumer group from falling permanently behind
   * when many messages (market events, status, user messages) arrive between
   * ticks — a backlog would otherwise leave a user message buried and unseen for
   * many ticks, so it would never bypass the context_hash gate or reach the LLM
   * prompt. Kept as a single Redis round-trip to stay within the tick read
   * timeout budget.
   */
  maxDrain?: number;
}

const DEFAULT_MAX_DRAIN = 200;

export async function readOutboundMessages(
  redis: Redis,
  options: OutboundMessageReaderOptions,
): Promise<Array<Record<string, unknown>>> {
  try {
    await redis.xgroup('CREATE', options.outboundStream, options.consumerGroup, '0', 'MKSTREAM').catch((err: unknown) => {
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
    });

    // Drain up to maxDrain messages in a single blocking read. Using a large
    // COUNT (rather than a multi-round loop) keeps this to one Redis round-trip,
    // so it stays well within the tick's OUTBOUND_READ_TIMEOUT_MS race budget
    // while still catching up on backlog. The runtime group would otherwise read
    // only `count` (~10) per tick and fall permanently behind when many messages
    // (market events, status, user messages) arrive between ticks — leaving a
    // user message buried for many ticks so it never bypasses the context_hash
    // gate or reaches the LLM prompt.
    const drainCount = options.maxDrain ?? DEFAULT_MAX_DRAIN;
    const messages: Array<Record<string, unknown>> = [];

    const result = await redis.xreadgroup(
      'GROUP', options.consumerGroup, options.consumerName,
      'COUNT', drainCount,
      'BLOCK', options.blockMs,
      'STREAMS', options.outboundStream, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return [];

    for (const [, entries] of result) {
      for (const [msgId, fields] of entries) {
        const envelopeIdx = fields.indexOf('envelope');
        if (envelopeIdx >= 0 && fields[envelopeIdx + 1]) {
          try {
            const envelope = JSON.parse(fields[envelopeIdx + 1]!) as Record<string, unknown>;
            messages.push(envelope);
          } catch {
            // Skip malformed
          }
        }
        await redis.xack(options.outboundStream, options.consumerGroup, msgId).catch(() => { /* ignore */ });
      }
    }

    return messages;
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}