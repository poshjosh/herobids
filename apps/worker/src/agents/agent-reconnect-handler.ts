import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { ContextSnapshotPayload } from '@herobids/domain';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'agent-reconnect-handler' });

export interface ReconnectConfig {
  /** Max number of high-value events to replay on reconnect. Default: 50 */
  maxReplayEvents: number;
  /** How far back to look for replay events (ms). Default: 3600000 (1 hour) */
  replayWindowMs: number;
}

/** Optional resolver to supply a live context snapshot on reconnect */
export interface ContextSnapshotResolver {
  resolveSnapshot(tradingInstanceId: string): ContextSnapshotPayload | undefined;
}

const DEFAULT_CONFIG: ReconnectConfig = {
  maxReplayEvents: 50,
  replayWindowMs: 3_600_000,
};

/** High-value event types worth replaying after reconnect */
const REPLAY_TYPES = new Set([
  'instance.plan.status',
  'instance.execution.result',
  'instance.guardrail.triggered',
  'instance.reconciliation.notice',
  'instance.decision.accepted',
  'instance.decision.rejected',
]);

/**
 * AgentReconnectHandler — sends recovery context to an agent after reconnect.
 *
 * Per the canonical recovery docs, reconnect sends:
 * 1. Latest `instance.status`
 * 2. Fresh `instance.context.snapshot`
 * 3. Bounded replay of high-value missed events
 */
export class AgentReconnectHandler {
  private readonly config: ReconnectConfig;

  constructor(
    private readonly redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    config?: Partial<ReconnectConfig>,
    private readonly snapshotResolver?: ContextSnapshotResolver,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Handle an agent runtime reconnect.
   * Called when a previously-disconnected runtime re-establishes its connection.
   */
  async handleReconnect(agentId: string, sessionId: string, tradingInstanceId: string): Promise<void> {
    logger.info({ agentId, sessionId, tradingInstanceId }, 'Handling agent reconnect');

    // 1. Update session status back to running
    await this.agentRepo.updateSession(sessionId, {
      status: 'running',
      lastHeartbeatAt: new Date(),
    });

    // 2. Emit latest instance status
    await this.eventPublisher.emitInstanceStatus(tradingInstanceId, {
      status: 'running',
      reason: 'reconnect_recovery',
      updatedAt: new Date().toISOString(),
    });

    // 3. Emit context snapshot if the instance is currently running
    if (this.snapshotResolver) {
      const snapshot = this.snapshotResolver.resolveSnapshot(tradingInstanceId);
      if (snapshot) {
        await this.eventPublisher.emitContextSnapshot(tradingInstanceId, snapshot);
        logger.debug({ agentId, sessionId }, 'Context snapshot sent on reconnect');
      } else {
        logger.debug({ agentId, sessionId }, 'No context snapshot available for reconnect (instance not running or no tick yet)');
      }
    }

    // 4. Replay bounded high-value missed events from the outbound stream
    await this.replayMissedEvents(tradingInstanceId, sessionId);

    logger.info({ agentId, sessionId }, 'Reconnect recovery complete');
  }

  /**
   * Replay high-value missed events from the outbound Redis stream.
   * Uses bounded time window and max count to prevent unbounded replay.
   */
  private async replayMissedEvents(tradingInstanceId: string, sessionId: string): Promise<void> {
    const streamKey = `agent:outbound:${tradingInstanceId}`;

    try {
      // Calculate the stream ID for the start of the replay window
      const windowStartMs = Date.now() - this.config.replayWindowMs;
      const startId = `${windowStartMs}-0`;

      // Read events from the stream within the window
      const results = await this.redis.xrange(
        streamKey,
        startId,
        '+',
        'COUNT',
        this.config.maxReplayEvents * 2, // Read more than needed, filter by type
      );

      if (!results || results.length === 0) {
        logger.debug({ tradingInstanceId, sessionId }, 'No events to replay');
        return;
      }

      let replayed = 0;
      for (const [_id, fields] of results) {
        if (replayed >= this.config.maxReplayEvents) break;

        // Fields is [key, value, key, value, ...]
        const fieldMap = new Map<string, string>();
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap.set(fields[i]!, fields[i + 1]!);
        }

        const envelopeRaw = fieldMap.get('envelope');
        if (!envelopeRaw) continue;

        // Skip entries that are themselves replay copies — prevents compounding
        // duplication where each reconnect replays the previous cycle's copies.
        if (fieldMap.get('is_replay') === '1') continue;

        try {
          const envelope = JSON.parse(envelopeRaw) as Record<string, unknown>;
          // Only replay high-value event types
          if (REPLAY_TYPES.has(envelope['type'] as string)) {
              // Re-publish with a fresh messageId so the agent runtime does not treat
              // this as a duplicate when deduplicating by messageId (per
              // recovery-and-replay.md §Duplicate Handling). The is_replay stream field
              // prevents cascading re-replay in future reconnect scans without relying
              // on messageId identity.
              const replayEnvelope = { ...envelope, messageId: crypto.randomUUID() };
              await this.redis.xadd(
                `agent:outbound:${tradingInstanceId}`,
                '*',
                'envelope', JSON.stringify(replayEnvelope),
                'is_replay', '1',
              );
            replayed++;
          }
        } catch {
          // Skip malformed entries
          continue;
        }
      }

      logger.info({ tradingInstanceId, sessionId, replayed }, 'Replayed missed events');
    } catch (err) {
      logger.error({ tradingInstanceId, err }, 'Failed to replay missed events');
    }
  }
}
