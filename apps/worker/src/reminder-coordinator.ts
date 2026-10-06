import type { Redis } from 'ioredis';
import type { ReminderConfig } from '@herobids/domain';
import { createLogger } from './logger.js';
import type { InstanceEventPublisher } from './agents/instance-event-publisher.js';
import type { AgentRepository } from '@herobids/db';
import { parseReminderRecord } from './reminders/reminder-record.js';
import { advanceRepeatingReminder } from './reminders/reminder-schedule.js';

const logger = createLogger('reminder-coordinator');

/** Redis key for the single-worker coordinator lease (D7). */
const LEASE_KEY = 'reminder-coordinator:lease';

/**
 * ReminderCoordinator — polls agent reminder hashes in Redis and fires wake events
 * via InstanceEventPublisher when a reminder's triggerAt has passed.
 *
 * Runs on one worker at a time via a Redis lease (D7). One-shot reminders are
 * removed after firing; repeating reminders are advanced to their next slot on
 * the original grid, reporting any occurrences missed while the agent was
 * stopped (D4). The coordinator performs no active-hours check — the runtime
 * gate lets reminder wakes through (D5).
 */
export class ReminderCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private leaseHeld = false;
  private ticking = false;
  /** Tracks the currently-running tick so stop() can await it before releasing the lease. */
  private tickDrain: Promise<void> = Promise.resolve();

  constructor(
    private readonly redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly workerId: string,
    private readonly config: ReminderConfig,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      // Only update tickDrain when no tick is already in flight. A concurrent
      // timer fire while a tick is running would otherwise overwrite the
      // active-tick promise with an immediately-resolved no-op, causing stop()
      // to drain early and release the lease before the in-flight tick completes.
      if (!this.ticking) {
        this.tickDrain = this.tick().catch((err) => {
          logger.error({ err }, 'ReminderCoordinator tick error');
        });
      }
    }, this.config.pollIntervalMs);
    logger.info({ pollIntervalMs: this.config.pollIntervalMs }, 'ReminderCoordinator started');
  }

  /**
   * Stop the poll loop and release the Redis lease so the next worker can take
   * over without waiting out the TTL. Async so callers can await lease release
   * before tearing down the Redis connection.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Drain any in-flight tick before releasing the lease. Without this, a
    // replacement worker could acquire the lease mid-publish and double-fire a
    // repeating reminder whose schedule has not yet been advanced in Redis.
    await this.tickDrain;
    if (this.leaseHeld) {
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await this.redis
        .eval(script, 1, LEASE_KEY, this.workerId)
        .catch((err: unknown) => logger.warn({ err }, 'Failed to release reminder coordinator lease'));
      this.leaseHeld = false;
    }
    logger.info('ReminderCoordinator stopped');
  }

  /**
   * Acquire or renew the single-worker lease. Returns true when this worker
   * holds the lease and may proceed with the poll, false otherwise.
   */
  private async acquireLease(): Promise<boolean> {
    const ttl = this.config.coordinatorLeaseTtlSeconds;
    if (!this.leaseHeld) {
      const result = await this.redis.set(LEASE_KEY, this.workerId, 'EX', ttl, 'NX');
      if (result !== 'OK') return false; // Another worker holds the lease
      this.leaseHeld = true;
      return true;
    }
    // Renew: only extend the TTL while we still own the key.
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;
    const renewed = (await this.redis.eval(script, 1, LEASE_KEY, this.workerId, String(ttl))) as number;
    if (renewed === 0) {
      this.leaseHeld = false; // Lost the lease
      return false;
    }
    return true;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // Prevent overlapping ticks (double-processing).
    this.ticking = true;
    try {
      // Singleton coordination: only poll if we hold the lease (D7).
      if (!(await this.acquireLease())) return;

      const activeAgents = await this.agentRepo.listActiveAgents();
      const now = Date.now();

      for (const agent of activeAgents) {
        await this.processAgentReminders(agent.id, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async processAgentReminders(agentId: string, now: number): Promise<void> {
    const key = `agent:reminders:${agentId}`;
    const all = await this.redis.hgetall(key);
    if (!all) return;

    for (const [reminderId, raw] of Object.entries(all)) {
      const parsed = parseReminderRecord(raw);
      if (!parsed.ok) {
        logger.warn({ agentId, reminderId }, 'Malformed reminder record — skipping');
        continue;
      }
      const reminder = parsed.data;

      // Skip legacy one-shot records already marked fired.
      if (reminder.firedAt) continue;

      const triggerMs = new Date(reminder.triggerAt).getTime();
      if (triggerMs > now) continue; // Not due yet

      // Repeating reminders advance to the next grid slot; one-shots have no
      // repeat and therefore no missed occurrences.
      const repeating = reminder.repeatEveryMs !== undefined;
      const advance = repeating
        ? advanceRepeatingReminder({ triggerAtMs: triggerMs, repeatEveryMs: reminder.repeatEveryMs!, nowMs: now })
        : { nextTriggerAtMs: 0, missedOccurrences: 0 };

      const nextTriggerAt = repeating ? new Date(advance.nextTriggerAtMs).toISOString() : undefined;
      const context = {
        reminderId,
        message: reminder.message,
        scheduledBy: reminder.scheduledBy ?? 'judge',
        ...(reminder.key !== undefined ? { key: reminder.key } : {}),
        ...(reminder.repeatEveryMs !== undefined ? { repeatEveryMs: reminder.repeatEveryMs } : {}),
        scheduledFor: reminder.triggerAt,
        missedOccurrences: advance.missedOccurrences,
        ...(nextTriggerAt !== undefined ? { nextTriggerAt } : {}),
      };

      try {
        await this.eventPublisher.emitAgentWake(agentId, {
          wakeId: reminderId,
          reason: reminder.message,
          eventIds: [reminderId],
          priority: 'normal',
          requestedAt: new Date().toISOString(),
          source: 'reminder',
          context,
        });
      } catch (err) {
        // Leave the record unchanged; it is retried on the next poll.
        logger.error({ agentId, reminderId, err }, 'Failed to fire reminder wake');
        continue;
      }

      // Publish succeeded — commit the schedule change.
      try {
        if (repeating) {
          const nextRecord = {
            ...reminder,
            triggerAt: nextTriggerAt!,
            lastFiredAt: new Date(now).toISOString(),
          };
          await this.redis.hset(key, reminderId, JSON.stringify(nextRecord));
        } else {
          await this.redis.hdel(key, reminderId);
        }
        logger.info(
          { agentId, reminderId, message: reminder.message, repeating, missedOccurrences: advance.missedOccurrences },
          'Reminder fired',
        );
      } catch (err) {
        logger.error({ agentId, reminderId, err }, 'Failed to update reminder record after firing');
      }
    }
  }
}
