import type { Redis } from 'ioredis';
import type { AgentMessageBroker } from './agent-message-broker.js';
import pino from 'pino';

const logger = pino({ name: 'agent-stream-consumer' });

export interface AgentStreamConsumerConfig {
  /** Consumer group name */
  group: string;
  /** Consumer name (unique per worker) */
  consumer: string;
  /** Stream key pattern — replaced with instance IDs at runtime */
  streamKeyPrefix: string;
  /** Block timeout in ms for XREADGROUP. Default: 5000 */
  blockMs: number;
  /** Max messages per read batch. Default: 10 */
  batchSize: number;
}

const DEFAULT_CONFIG: AgentStreamConsumerConfig = {
  group: 'agent-broker',
  consumer: `worker-${process.pid}`,
  streamKeyPrefix: 'agent:inbound:',
  blockMs: 5000,
  batchSize: 10,
};

/**
 * AgentStreamConsumer — reads inbound agent messages from Redis Streams
 * and routes them through the AgentMessageBroker.
 *
 * Uses Redis consumer groups for at-least-once delivery with durable cursoring.
 */
export class AgentStreamConsumer {
  private running = false;
  private readonly config: AgentStreamConsumerConfig;
  private readonly subscribedStreams = new Set<string>();

  constructor(
    private readonly redis: Redis,
    private readonly broker: AgentMessageBroker,
    config?: Partial<AgentStreamConsumerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Subscribe to a trading instance's inbound stream */
  async subscribe(tradingInstanceId: string): Promise<void> {
    const streamKey = `${this.config.streamKeyPrefix}${tradingInstanceId}`;
    if (this.subscribedStreams.has(streamKey)) return;

    // Ensure consumer group exists (MKSTREAM creates stream if absent)
    try {
      await this.redis.xgroup('CREATE', streamKey, this.config.group, '0', 'MKSTREAM');
    } catch (err: unknown) {
      // Group already exists — that's fine
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }

    this.subscribedStreams.add(streamKey);
    logger.info({ streamKey, group: this.config.group }, 'Subscribed to agent inbound stream');
  }

  /** Unsubscribe from a trading instance's inbound stream */
  unsubscribe(tradingInstanceId: string): void {
    const streamKey = `${this.config.streamKeyPrefix}${tradingInstanceId}`;
    this.subscribedStreams.delete(streamKey);
  }

  /** Start the consumer loop */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('Agent stream consumer started');

    // Run the read loop
    this.readLoop();
  }

  /** Stop the consumer loop */
  stop(): void {
    this.running = false;
    logger.info('Agent stream consumer stopping');
  }

  private async readLoop(): Promise<void> {
    while (this.running) {
      if (this.subscribedStreams.size === 0) {
        // No streams to read — wait briefly
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      try {
        const streams = [...this.subscribedStreams];
        const ids = streams.map(() => '>'); // Read only new messages

        const results = await this.redis.xreadgroup(
          'GROUP',
          this.config.group,
          this.config.consumer,
          'COUNT',
          this.config.batchSize,
          'BLOCK',
          this.config.blockMs,
          'STREAMS',
          ...streams,
          ...ids,
        );

        if (!results) continue;

        for (const [_streamKey, messages] of results) {
          for (const [messageStreamId, fields] of messages) {
            await this.processMessage(messageStreamId, fields, _streamKey as string);
          }
        }
      } catch (err) {
        if (this.running) {
          logger.error({ err }, 'Error in agent stream consumer read loop');
          // Back off briefly before retrying
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  private async processMessage(streamId: string, fields: string[], streamKey: string): Promise<void> {
    // Fields come as flat array: ['key1', 'val1', 'key2', 'val2', ...]
    const fieldMap = new Map<string, string>();
    for (let i = 0; i < fields.length; i += 2) {
      fieldMap.set(fields[i]!, fields[i + 1]!);
    }

    const envelopeRaw = fieldMap.get('envelope');
    if (!envelopeRaw) {
      logger.warn({ streamId, streamKey }, 'Message missing envelope field');
      await this.ack(streamKey, streamId);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(envelopeRaw);
    } catch {
      logger.warn({ streamId }, 'Failed to parse message envelope JSON');
      await this.ack(streamKey, streamId);
      return;
    }

    // Route through the broker
    const result = await this.broker.processInbound(parsed);
    if (!result.accepted) {
      logger.debug({ streamId, error: result.error }, 'Message not accepted');
    }

    // Always ACK — failed messages are tracked in the agent_messages table
    await this.ack(streamKey, streamId);
  }

  private async ack(streamKey: string, streamId: string): Promise<void> {
    try {
      await this.redis.xack(streamKey, this.config.group, streamId);
    } catch (err) {
      logger.error({ streamKey, streamId, err }, 'Failed to ACK message');
    }
  }
}
