import type { Logger } from 'pino';
import type Redis from 'ioredis';
import type { AlertsConfig } from '@herobids/domain';
import type { PgJournal, AlertDeliveryRepository } from '@herobids/db';
import { evaluateAlertPolicy, type JournalEventRow } from './alert-policy.js';
import { TelegramClient } from './telegram-client.js';

const DISPATCH_LEASE_KEY = 'lease:alert-dispatcher';
const DISPATCH_LEASE_TTL = 30; // seconds

/**
 * Alert dispatcher — polls journal for new events, evaluates alert policy,
 * creates delivery records, and attempts delivery via configured channels.
 *
 * Runs as a long-lived loop within the worker process.
 */
export class AlertDispatcher {
  private cursor: { createdAt: Date; seenIds: string[] } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly telegram: TelegramClient | undefined;
  /** Per-type cooldown tracking: type → last alert timestamp */
  private readonly cooldowns = new Map<string, number>();
  private leaseHeld = false;
  private ticking = false;
  /** Tracks the currently-running tick so stop() can await it before releasing the lease */
  private tickDrain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AlertsConfig,
    private readonly journal: PgJournal,
    private readonly deliveryRepo: AlertDeliveryRepository,
    private readonly logger: Logger,
    private readonly redis?: Redis,
    private readonly workerId?: string,
  ) {
    if (config.telegram.botToken) {
      this.telegram = new TelegramClient(config.telegram.botToken);
    }
  }

  /** Start the dispatch loop */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('Alert dispatcher disabled by config');
      return;
    }
    if (!this.telegram) {
      this.logger.warn('Alert dispatcher enabled but no TELEGRAM_BOT_TOKEN configured');
      return;
    }

    if (this.config.telegram.channels.length === 0) {
      this.logger.warn('Alert dispatcher enabled but no Telegram channels configured — nothing will be routed');
      return;
    }

    this.logger.info({ intervalMs: this.config.dispatchIntervalMs }, 'Alert dispatcher started');

    // Seed cooldown map from recent deliveries so restarts don't resend within window
    await this.seedCooldownsFromDb();

    this.timer = setInterval(() => {
      // Only update tickDrain when no tick is already in flight. A concurrent
      // timer fire while a tick is running returns an immediately-resolved
      // no-op that would overwrite the active-tick promise, causing stop() to
      // drain early and release the Redis lease before the send completes.
      if (!this.ticking) {
        this.tickDrain = this.tick();
      }
    }, this.config.dispatchIntervalMs);

    // Run immediately on start (ticking is always false here)
    this.tickDrain = this.tick();
  }

  /** Stop the dispatch loop.
   *
   * Returns a promise so the caller can await lease release before tearing down
   * the Redis connection — if stop() is fire-and-forget the DEL script may never
   * be sent and the lease stays until TTL expiry.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Drain any in-flight tick before releasing the lease. Without this, a
    // replacement worker could acquire the lease mid-send and double-deliver
    // the same Telegram messages for events already being processed.
    await this.tickDrain;
    // Release the Redis singleton lease immediately so the next worker can
    // acquire it without waiting out the TTL after a graceful shutdown.
    if (this.redis && this.workerId && this.leaseHeld) {
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
      await this.redis
        .eval(script, 1, DISPATCH_LEASE_KEY, this.workerId)
        .catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to release alert dispatcher lease'));
      this.leaseHeld = false;
    }
    this.logger.info('Alert dispatcher stopped');
  }

  /** Single dispatch tick: acquire lease → scan → evaluate → deliver → retry */
  private async tick(): Promise<void> {
    if (this.ticking) return; // Prevent overlapping ticks
    this.ticking = true;
    try {
      // Singleton coordination: only dispatch if we hold the lease
      if (this.redis && this.workerId) {
        if (!this.leaseHeld) {
          const result = await this.redis.set(DISPATCH_LEASE_KEY, this.workerId, 'EX', DISPATCH_LEASE_TTL, 'NX');
          if (result !== 'OK') return; // Another worker holds the lease
          this.leaseHeld = true;
        } else {
          // Renew the lease
          const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;
          const renewed = await this.redis.eval(script, 1, DISPATCH_LEASE_KEY, this.workerId, String(DISPATCH_LEASE_TTL)) as number;
          if (renewed === 0) {
            this.leaseHeld = false;
            return; // Lost the lease
          }
        }
      }

      // Scan for new events since last cursor
      const events = await this.journal.scanAfter({
        cursor: this.cursor,
        typePrefixes: this.collectPrefixes(),
        limit: this.config.maxBatchSize,
      });

      if (events.length > 0) {
        // Apply cooldown filter
        const filteredEvents = this.applyCooldowns(events as JournalEventRow[]);

        if (filteredEvents.length > 0) {
          // Evaluate alert policy
          const routings = evaluateAlertPolicy(filteredEvents, this.config);

          // Create delivery records and attempt send
          for (const routing of routings) {
            for (const dest of routing.destinations) {
              const deliveryId = await this.deliveryRepo.insert({
                journalEventId: routing.event.id,
                channel: dest.channel,
                destination: dest.chatId,
              });

              // null means duplicate — already delivered or pending
              if (deliveryId) {
                await this.attemptDelivery(deliveryId, dest.chatId, routing.event);
              }
            }
          }
        }

        // Advance cursor only after delivery rows have been inserted for this batch.
        // If processing throws before reaching here the cursor stays in place, so the
        // next tick re-scans the same events and hits ON CONFLICT DO NOTHING on any
        // rows that were already inserted — safe at-least-once semantics.
        const last = events[events.length - 1]!;
        const lastTs = last.createdAt.getTime();
        // Collect all IDs from the boundary timestamp so the next scan's NOT IN
        // filter can safely use >= on createdAt without re-processing seen events.
        const seenIds = events.filter((e) => e.createdAt.getTime() === lastTs).map((e) => e.id);
        this.cursor = { createdAt: last.createdAt, seenIds };
      }

      // Retry previously failed deliveries
      await this.retryPending();
    } catch (e) {
      this.logger.error({ err: e }, 'Alert dispatcher tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Attempt to deliver a single alert */
  private async attemptDelivery(deliveryId: string, chatId: string, event: JournalEventRow): Promise<void> {
    if (!this.telegram) return;

    const result = await this.telegram.sendAlert(chatId, event);
    if (result.ok) {
      await this.deliveryRepo.markDelivered(deliveryId);
      // Advance cooldown only after confirmed delivery so a send failure does not
      // suppress subsequent retries of the same event type within the cooldown window.
      // Key is instance-scoped so a crash on one instance does not suppress crash
      // alerts from other instances during the cooldown window.
      this.cooldowns.set(this.cooldownKey(event), Date.now());
      this.logger.debug({ deliveryId, chatId, eventType: event.type }, 'Alert delivered');
    } else {
      await this.deliveryRepo.markAttemptFailed(deliveryId, result.error.message, this.config.maxRetries);
      this.logger.warn({ deliveryId, chatId, error: result.error }, 'Alert delivery failed');
    }
  }

  /** Apply cooldown — suppress duplicates of the same (instance, event-type) pair within cooldown window.
   *
   * NOTE: this method only filters; it does NOT advance the cooldown map. The map
   * is advanced in attemptDelivery only after a confirmed successful send, so that
   * a Telegram failure does not silently suppress future alerts of the same type.
   *
   * The cooldown key is scoped to (botId, type) so that the same event
   * type on different instances each get their own independent cooldown.
   */
  private applyCooldowns(events: JournalEventRow[]): JournalEventRow[] {
    const now = Date.now();
    const result: JournalEventRow[] = [];
    // Deduplicate within this batch (same key scoping as cooldown map)
    const seen = new Set<string>();

    for (const event of events) {
      const key = this.cooldownKey(event);
      const lastSent = this.cooldowns.get(key);
      if (lastSent && now - lastSent < this.config.defaultCooldownMs) {
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(event);
    }

    return result;
  }

  /** Build a cooldown map key scoped to (botId, type). */
  private cooldownKey(event: { botId?: string | null; actorId?: string | null; type: string }): string {
    return `${event.botId ?? event.actorId ?? ''}:${event.type}`;
  }

  /** Collect all unique event prefixes from channel configs */
  private collectPrefixes(): string[] {
    const prefixes = new Set<string>();
    for (const channel of this.config.telegram.channels) {
      for (const prefix of channel.eventPrefixes) {
        prefixes.add(prefix);
      }
    }
    return [...prefixes];
  }

  /**
   * Seed in-memory cooldown map from recent DB deliveries.
   * Called once on start so the cooldown window survives worker restarts.
   * Fetches the most recently delivered journal events and seeds type→timestamp.
   */
  private async seedCooldownsFromDb(): Promise<void> {
    try {
      const now = Date.now();
      const cutoff = new Date(now - this.config.defaultCooldownMs);

      // Find recent deliveries within the cooldown window.
      // Use a generous cap (500) rather than maxBatchSize so that bursty periods
      // don't truncate the seed set and cause duplicate alerts immediately after a restart.
      const recent = await this.deliveryRepo.getRecentDeliveredAfter(cutoff, 500);
      if (recent.length === 0) return;

      // Look up the journal events to get their types and match with delivery timestamps.
      // Keyed by journalEventId so we use the actual confirmed delivery time (deliveredAt),
      // not the event creation time — ensures the cooldown window is measured from when
      // the alert was sent, not from when the event was generated.
      const deliveredAtByEventId = new Map(
        recent.map((r) => [r.journalEventId, r.deliveredAt!.getTime()]),
      );
      const eventIds = recent.map((r) => r.journalEventId);
      const events = await this.journal.getByIds(eventIds);
      for (const event of events) {
        const key = this.cooldownKey(event);
        const deliveredAt = deliveredAtByEventId.get(event.id);
        if (deliveredAt === undefined) {
          continue;
        }

        // Keep the newest confirmed delivery for each cooldown key. getByIds()
        // does not guarantee result ordering, so choosing the max makes restart
        // seeding deterministic when multiple recent events share a key.
        const lastSeededAt = this.cooldowns.get(key);
        if (lastSeededAt === undefined || deliveredAt > lastSeededAt) {
          this.cooldowns.set(key, deliveredAt);
        }
      }
      this.logger.debug({ seeded: events.length }, 'Cooldown map seeded from DB');
    } catch (e) {
      this.logger.warn({ err: e }, 'Failed to seed cooldowns from DB');
    }
  }

  /** Retry pending deliveries that previously failed. Called periodically. */
  private async retryPending(): Promise<void> {
    if (!this.telegram) return;

    const pending = await this.deliveryRepo.getPending({
      maxRetries: this.config.maxRetries,
      limit: this.config.maxBatchSize,
    });

    for (const delivery of pending) {
      const event = await this.journal.getById(delivery.journalEventId);
      if (!event) {
        await this.deliveryRepo.markAttemptFailed(delivery.id, 'Journal event not found', this.config.maxRetries);
        continue;
      }

      await this.attemptDelivery(delivery.id, delivery.destination, event as JournalEventRow);
    }
  }
}
