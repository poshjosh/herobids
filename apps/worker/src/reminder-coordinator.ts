import type { Redis } from 'ioredis';
import pino from 'pino';
import type { InstanceEventPublisher } from './agents/instance-event-publisher.js';
import type { AgentRepository } from '@herobids/db';
import type { ReminderRecord } from './tools/tasks.js';

const logger = pino({ name: 'reminder-coordinator' });

/** How often to poll Redis for due reminders (ms). */
const POLL_INTERVAL_MS = 10_000;

/**
 * ReminderCoordinator — polls agent reminder hashes in Redis and fires wake events
 * via InstanceEventPublisher when a reminder's triggerAt has passed.
 *
 * One-shot reminders only (this slice). After firing, the reminder is marked as
 * fired by recording firedAt and removed from the pending set.
 */
export class ReminderCoordinator {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly redis: Redis,
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, 'ReminderCoordinator tick error');
      });
    }, POLL_INTERVAL_MS);
    logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'ReminderCoordinator started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    // Find all active agents to scan their reminders
    const activeAgents = await this.agentRepo.listActiveAgents();
    const now = Date.now();

    for (const agent of activeAgents) {
      await this.processAgentReminders(agent.id, now);
    }
  }

  private async processAgentReminders(agentId: string, now: number): Promise<void> {
    const key = `agent:reminders:${agentId}`;
    const all = await this.redis.hgetall(key);
    if (!all) return;

    for (const [reminderId, raw] of Object.entries(all)) {
      let reminder: ReminderRecord;
      try {
        reminder = JSON.parse(raw) as ReminderRecord;
      } catch {
        logger.warn({ agentId, reminderId }, 'Malformed reminder record — skipping');
        continue;
      }

      // Skip already-fired reminders
      if (reminder.firedAt) continue;

      const triggerMs = new Date(reminder.triggerAt).getTime();
      if (triggerMs > now) continue;

      // Trigger is due — fire a wake and mark fired
      try {
        await this.eventPublisher.emitAgentMarketWake(agentId, {
          wakeId: `reminder:${reminderId}`,
          reason: `reminder:${reminder.message}`,
          eventIds: [reminderId],
          priority: 'normal',
          requestedAt: new Date().toISOString(),
        });

        // Remove the fired reminder from the active queue after it wakes the agent.
        await this.redis.hdel(key, reminderId);
        logger.info({ agentId, reminderId, message: reminder.message }, 'Reminder fired');
      } catch (err) {
        logger.error({ agentId, reminderId, err }, 'Failed to fire reminder wake');
      }
    }
  }
}
