import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { ContextSnapshotPayload } from '@herobids/domain';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-reconnect-handler');

export interface ReconnectConfig {
  /** Max number of high-value events to replay on reconnect. Default: 50 */
  maxReplayEvents: number;
  /** How far back to look for replay events (ms). Default: 3600000 (1 hour) */
  replayWindowMs: number;
}

/** Optional resolver to supply live context snapshots on reconnect */
export interface ContextSnapshotResolver {
  resolveSnapshot(agentId: string): Promise<ContextSnapshotPayload | undefined> | ContextSnapshotPayload | undefined;
  /** Resolve snapshots for all tracked instruments. Falls back to resolveSnapshot if not implemented. */
  resolveSnapshots?(agentId: string): Promise<ContextSnapshotPayload[]> | ContextSnapshotPayload[];
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
  async handleReconnect(agentId: string, sessionId: string): Promise<void> {
    logger.info({ agentId, sessionId }, 'Handling agent reconnect');

    // 1. Update session status back to running
    await this.agentRepo.updateSession(sessionId, {
      status: 'running',
      lastHeartbeatAt: new Date(),
    });

    // 2. Emit latest instance status
    await this.eventPublisher.emitInstanceStatus(agentId, {
      status: 'running',
      reason: 'reconnect_recovery',
      updatedAt: new Date().toISOString(),
    });

    // 3. Emit context snapshots for all tracked instruments
    if (this.snapshotResolver) {
      const snapshots = this.snapshotResolver.resolveSnapshots
        ? await this.snapshotResolver.resolveSnapshots(agentId)
        : [];

      if (snapshots.length > 0) {
        for (const snapshot of snapshots) {
          await this.eventPublisher.emitContextSnapshot(agentId, snapshot);
        }
        logger.debug({ agentId, sessionId, count: snapshots.length }, 'Context snapshots sent on reconnect');
      } else {
        // Fallback to single-snapshot resolver for backward compat (bot actors)
        const snapshot = await this.snapshotResolver.resolveSnapshot(agentId);
        if (snapshot) {
          await this.eventPublisher.emitContextSnapshot(agentId, snapshot);
          logger.debug({ agentId, sessionId }, 'Context snapshot sent on reconnect');
        } else {
          logger.debug({ agentId, sessionId }, 'No context snapshot available for reconnect (instance not running or no tick yet)');
        }
      }
    }

    // 4. Replay bounded high-value missed events from the outbound stream
    await this.replayMissedEvents(agentId, sessionId);

    logger.info({ agentId, sessionId }, 'Reconnect recovery complete');
  }

  /**
   * Replay high-value missed events from the outbound Redis stream.
   * Uses bounded time window and max count to prevent unbounded replay.
   */
  private async replayMissedEvents(agentId: string, sessionId: string): Promise<void> {
    const streamKey = `agent:outbound:${agentId}`;

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
        logger.debug({ agentId, sessionId }, 'No events to replay');
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
            // Preserve the original messageId so reconnect replay remains compatible
            // with the protocol's duplicate-safe delivery contract.
            await this.redis.xadd(
              `agent:outbound:${agentId}`,
              '*',
              'envelope', JSON.stringify(envelope),
              'is_replay', '1',
            );
            replayed++;
          }
        } catch {
          // Skip malformed entries
          continue;
        }
      }

      logger.info({ agentId, sessionId, replayed }, 'Replayed missed events');
    } catch (err) {
      logger.error({ agentId, err }, 'Failed to replay missed events');
    }
  }
}
