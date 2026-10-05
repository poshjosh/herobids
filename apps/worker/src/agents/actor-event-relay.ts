import type { Logger } from 'pino';
import type Redis from 'ioredis';
import { z } from 'zod';
import { AgentWakePayloadSchema, type ActorEventRelayConfig, type InstanceStatusPayload } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { UserEventPublisher } from '../user-event-publisher.js';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { TechnicalScanState } from '../runtime-composition.js';
import type { ConsumerNotificationFeed, ConsumerNotificationRow } from './boundary-consumer-notification-feed.js';

const LEASE_KEY = 'lease:actor-event-relay';
const LEASE_TTL = 30; // seconds
const CURSOR_KEY = 'actor-event-relay:cursor';

/** Payload shapes per notification type (traderton consumer-notifier vocabulary). */
const AgentWakeNotificationSchema = z.object({ wake: AgentWakePayloadSchema });
const ScanCompletedNotificationSchema = z.object({ scan: z.record(z.unknown()) });
const JournalEventNotificationSchema = z.object({ journalType: z.string().min(1), detail: z.string() });
const BotStatusNotificationSchema = z.object({
  status: z.enum(['stopped', 'crashed']),
  reason: z.string(),
  managedBots: z.array(z.object({ id: z.string(), status: z.string() })),
});
const AgentStatusNotificationSchema = z.object({ status: z.literal('crashed'), error: z.string() });

interface PersistedCursor {
  createdAt: string;
  seenIds: string[];
}

/**
 * ActorEventRelay (E3-H) — polls traderton's `consumer_notifications` outbox and
 * republishes each row onto the herobids agent streams (so a scanner_gated
 * agent receives its scanner wakes without ever calling submit_decision).
 *
 * Singleton-coordinated via a Redis lease (modelled on AlertDispatcher). The
 * cursor is persisted in Redis so a restart resumes rather than replays from the
 * start. Rows younger than `settleLagMs` are not processed, so out-of-order
 * commits (createdAt = DB now() from many writers) settle before the cursor
 * passes them. A republish uses the STRICT publisher variants: a failed XADD
 * throws, the batch stops, and the cursor is NOT advanced past the failed row,
 * so the next tick retries it.
 *
 * NOTE: rows older than traderton's `consumer_notifications` retention (7 days)
 * are lost if the relay is down longer than that.
 */
export class ActorEventRelay {
  private timer: ReturnType<typeof setInterval> | undefined;
  private leaseHeld = false;
  private ticking = false;
  private tickDrain: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      config: ActorEventRelayConfig;
      feed: ConsumerNotificationFeed;
      eventPublisher: Pick<
        InstanceEventPublisher,
        'emitAgentWakeStrict' | 'emitTechnicalScanCompletedStrict' | 'emitJournalEventStrict' | 'emitInstanceStatusStrict'
      >;
      userEventPublisher: Pick<UserEventPublisher, 'publishBotStatusStrict'>;
      sessionManager: Pick<AgentSessionManager, 'handleRuntimeFailure'>;
      agentRepo: Pick<AgentRepository, 'getActiveSession'>;
      redis?: Redis;
      workerId?: string;
      logger: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async start(): Promise<void> {
    if (!this.deps.config.enabled) {
      this.deps.logger.info('Actor-event relay disabled by config');
      return;
    }
    this.deps.logger.info({ intervalMs: this.deps.config.pollIntervalMs }, 'Actor-event relay started');
    this.timer = setInterval(() => {
      if (!this.ticking) this.tickDrain = this.tick();
    }, this.deps.config.pollIntervalMs);
    this.tickDrain = this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.tickDrain;
    if (this.deps.redis && this.deps.workerId && this.leaseHeld) {
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await this.deps.redis
        .eval(script, 1, LEASE_KEY, this.deps.workerId)
        .catch((e: unknown) => this.deps.logger.warn({ err: e }, 'Failed to release actor-event relay lease'));
      this.leaseHeld = false;
    }
    this.deps.logger.info('Actor-event relay stopped');
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.holdLease())) return;

      const cursor = await this.loadCursor();
      const rows = await this.deps.feed.scan({
        cursor: { createdAt: new Date(cursor.createdAt), seenIds: cursor.seenIds },
        limit: this.deps.config.maxBatchSize,
      });
      if (rows.length === 0) return;

      const horizon = this.now() - this.deps.config.settleLagMs;
      const handled: ConsumerNotificationRow[] = [];
      for (const row of rows) {
        // Stop at the first row younger than the settle lag — do not process or
        // pass it, so out-of-order commits at the boundary settle first.
        if (row.createdAt.getTime() > horizon) break;
        try {
          await this.processRow(row);
        } catch (err) {
          // A republish failed — stop the batch and do NOT advance past this
          // row. The next tick re-scans from the current cursor and retries.
          this.deps.logger.error({ err, id: row.id, type: row.type }, 'Actor-event relay republish failed — holding cursor');
          if (handled.length > 0) await this.advanceCursor(cursor, handled);
          return;
        }
        handled.push(row);
      }

      if (handled.length > 0) await this.advanceCursor(cursor, handled);
    } catch (err) {
      this.deps.logger.error({ err }, 'Actor-event relay tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Republish one row via the strict publishers. Throws to hold the cursor. */
  private async processRow(row: ConsumerNotificationRow): Promise<void> {
    const ageMs = this.now() - row.createdAt.getTime();
    switch (row.type) {
      case 'agent_wake': {
        const parsed = AgentWakeNotificationSchema.safeParse(row.payload);
        if (!parsed.success || !row.agentId) {
          this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: malformed agent_wake — skipping');
          return;
        }
        if (ageMs > this.deps.config.maxEventAgeMs) {
          this.deps.logger.debug({ id: row.id }, 'Actor-event relay: stale agent_wake — skipping');
          return;
        }
        await this.deps.eventPublisher.emitAgentWakeStrict(row.agentId, parsed.data.wake);
        return;
      }
      case 'scan_completed': {
        const parsed = ScanCompletedNotificationSchema.safeParse(row.payload);
        if (!parsed.success || !row.agentId) {
          this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: malformed scan_completed — skipping');
          return;
        }
        if (ageMs > this.deps.config.maxEventAgeMs) {
          this.deps.logger.debug({ id: row.id }, 'Actor-event relay: stale scan_completed — skipping');
          return;
        }
        // The scan payload is the parity-locked TechnicalScanState shape (plus
        // an optional signalsTruncated flag) that traderton already validated and
        // stored verbatim. The relay is a transparent forwarder, so it does not
        // re-validate the full shape — a trust-boundary cast to the forwarded type.
        await this.deps.eventPublisher.emitTechnicalScanCompletedStrict(
          row.agentId,
          parsed.data.scan as unknown as TechnicalScanState,
        );
        return;
      }
      case 'journal_event': {
        const parsed = JournalEventNotificationSchema.safeParse(row.payload);
        if (!parsed.success) {
          this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: malformed journal_event — skipping');
          return;
        }
        if (!row.agentId) {
          this.deps.logger.debug({ id: row.id }, 'Actor-event relay: journal_event with no agentId — skipping');
          return;
        }
        await this.deps.eventPublisher.emitJournalEventStrict(row.agentId, {
          journalType: parsed.data.journalType,
          detail: parsed.data.detail,
          timestamp: row.createdAt.toISOString(),
        });
        return;
      }
      case 'bot_status': {
        const parsed = BotStatusNotificationSchema.safeParse(row.payload);
        if (!parsed.success) {
          this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: malformed bot_status — skipping');
          return;
        }
        if (row.agentId) {
          const payload: InstanceStatusPayload = {
            status: parsed.data.status,
            reason: parsed.data.reason,
            managedBots: parsed.data.managedBots,
            updatedAt: row.createdAt.toISOString(),
          };
          await this.deps.eventPublisher.emitInstanceStatusStrict(row.agentId, payload);
        }
        if (row.botId) {
          await this.deps.userEventPublisher.publishBotStatusStrict(row.ownerId, row.botId, parsed.data.status);
        }
        return;
      }
      case 'agent_status': {
        const parsed = AgentStatusNotificationSchema.safeParse(row.payload);
        if (!parsed.success || !row.agentId) {
          this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: malformed agent_status — skipping');
          return;
        }
        const session = await this.deps.agentRepo.getActiveSession(row.agentId);
        if (session && row.createdAt >= session.startedAt) {
          await this.deps.sessionManager.handleRuntimeFailure(session.id, row.agentId, row.ownerId, new Error(parsed.data.error));
        } else {
          this.deps.logger.info({ id: row.id, agentId: row.agentId }, 'Actor-event relay: agent_status with no matching live session — skipping');
        }
        return;
      }
      default:
        this.deps.logger.warn({ id: row.id, type: row.type }, 'Actor-event relay: unknown notification type — skipping');
    }
  }

  /** Acquire or renew the singleton lease. Returns false when not the holder. */
  private async holdLease(): Promise<boolean> {
    if (!this.deps.redis || !this.deps.workerId) return true;
    if (!this.leaseHeld) {
      const result = await this.deps.redis.set(LEASE_KEY, this.deps.workerId, 'EX', LEASE_TTL, 'NX');
      if (result !== 'OK') return false;
      this.leaseHeld = true;
      return true;
    }
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;
    const renewed = (await this.deps.redis.eval(script, 1, LEASE_KEY, this.deps.workerId, String(LEASE_TTL))) as number;
    if (renewed === 0) {
      this.leaseHeld = false;
      return false;
    }
    return true;
  }

  /**
   * Load the persisted cursor from Redis, or initialise it to
   * now - settleLagMs (so the first tick starts near the present, not replaying
   * the whole table) and persist it.
   *
   * NOTE: herobids/traderton clocks are assumed NTP-synced; skew beyond
   * settleLagMs can drop or replay rows. Replayed wakes are filtered by the
   * stale guard; a dropped wake simply misses one scan interval.
   */
  private async loadCursor(): Promise<PersistedCursor> {
    if (this.deps.redis) {
      const raw = await this.deps.redis.get(CURSOR_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as PersistedCursor;
          if (typeof parsed.createdAt === 'string' && Array.isArray(parsed.seenIds)) return parsed;
        } catch {
          this.deps.logger.warn('Actor-event relay: corrupt cursor — reinitialising');
        }
      }
    }
    const cursor: PersistedCursor = { createdAt: new Date(this.now() - this.deps.config.settleLagMs).toISOString(), seenIds: [] };
    if (this.deps.redis) await this.deps.redis.set(CURSOR_KEY, JSON.stringify(cursor));
    return cursor;
  }

  /**
   * Advance the cursor to the last handled row. `seenIds` holds every handled id
   * sharing the last row's millisecond timestamp; when that timestamp equals the
   * previous cursor's, the seen sets are merged (so a tie across ticks is not
   * reprocessed).
   */
  private async advanceCursor(previous: PersistedCursor, handled: ConsumerNotificationRow[]): Promise<void> {
    const last = handled[handled.length - 1]!;
    const lastMs = last.createdAt.getTime();
    const idsAtTs = handled.filter((r) => r.createdAt.getTime() === lastMs).map((r) => r.id);
    const previousMs = new Date(previous.createdAt).getTime();
    const seenIds = previousMs === lastMs ? [...new Set([...previous.seenIds, ...idsAtTs])] : idsAtTs;
    const cursor: PersistedCursor = { createdAt: new Date(lastMs).toISOString(), seenIds };
    if (this.deps.redis) await this.deps.redis.set(CURSOR_KEY, JSON.stringify(cursor));
  }
}
