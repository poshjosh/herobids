import type { Redis } from 'ioredis';

export const OUTBOUND_READ_BLOCK_MS = 1500;
export const OUTBOUND_READ_TIMEOUT_MS = 2000;

export interface OutboundMessageReaderOptions {
  outboundStream: string;
  consumerGroup: string;
  consumerName: string;
  blockMs: number;
  count?: number;
}

export async function readOutboundMessages(
  redis: Redis,
  options: OutboundMessageReaderOptions,
): Promise<Array<Record<string, unknown>>> {
  try {
    await redis.xgroup('CREATE', options.outboundStream, options.consumerGroup, '0', 'MKSTREAM').catch((err: unknown) => {
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
    });

    const result = await redis.xreadgroup(
      'GROUP', options.consumerGroup, options.consumerName,
      'COUNT', options.count ?? 10,
      'BLOCK', options.blockMs,
      'STREAMS', options.outboundStream, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;

    if (!result) return [];

    const messages: Array<Record<string, unknown>> = [];
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