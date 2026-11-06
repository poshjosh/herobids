import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';
import { isUserMessageType } from '../tick-gate-state.js';

const logger = createLogger('outbound-inbox');

export const OUTBOUND_READ_BLOCK_MS = 1500;
export const OUTBOUND_READ_TIMEOUT_MS = 2000;

const DEFAULT_MAX_DRAIN = 200;
const SLOW_FETCH_MS = 500;
const LOGGED_IDS = 5;
const CLAIM_PAGE = 100;
const DEAD_LETTER_MAXLEN = 1000;
const ATTEMPTS_TTL_SECONDS = 86400;

/**
 * How a tick ended, as far as its outbound entries are concerned:
 * - `completed`: the tick used its entries. They are acknowledged, and user messages are marked handled.
 * - `failed`: the tick did not use them. They stay pending for the next read.
 * - `held`: the tick was paused and its entries sit in memory. They stay handed over until a tick completes.
 */
export type TickOutcome = 'completed' | 'failed' | 'held';

export interface OutboundEntry {
  streamId: string;
  envelope: Record<string, unknown>;
}

export interface OutboundInboxOptions {
  outboundStream: string;
  consumerGroup: string;
  consumerName: string;
  /** Prefix of the per-message marker that records a user message as handled. The message id is appended. */
  handledKeyPrefix: string;
  handledTtlSeconds: number;
  /** Hash of failed-tick counts, keyed by stream id. */
  attemptsKey: string;
  /** Stream that receives entries dropped after `maxAttempts` failed ticks, so they stay recoverable. */
  deadLetterStream: string;
  maxAttempts: number;
  maxDrain?: number;
}

type XReadGroupReply = Array<[string, Array<[string, string[] | null]>]> | null;
type XPendingRow = [string, string, number, number];

/**
 * The runtime's view of the platform → agent stream (`agent:outbound:<id>`), read through the `agent-runtime` group.
 *
 * An entry is acknowledged only once a tick has completed with it in hand. Until then it stays pending, and the next
 * fetch returns it again. So a read whose result is discarded, a tick that fails, and a process that dies all leave
 * their entries for the next read. A user message whose tick completed gets a handled marker before its
 * acknowledgement, so a replay after a crash skips it. An entry that fails `maxAttempts` ticks is dead-lettered.
 */
export class OutboundInbox {
  private groupReady = false;
  /** Entries handed to the runtime and not yet settled, keyed by stream id. */
  private readonly handed = new Map<string, OutboundEntry>();

  constructor(
    private readonly redis: Redis,
    private readonly options: OutboundInboxOptions,
  ) {}

  /**
   * Entries the tick has not yet taken: pending ones first (earlier reads that were never handed over), then new ones.
   * Acknowledges nothing, except malformed, deleted, already-handled and dead-lettered entries.
   */
  async fetch(blockMs: number): Promise<OutboundEntry[]> {
    const startedAt = Date.now();
    await this.ensureGroup();
    const drain = this.options.maxDrain ?? DEFAULT_MAX_DRAIN;

    // Handed entries also occupy the pending window, so widen it by their count.
    const pending = await this.readPending(drain + this.handed.size);
    const remaining = drain - pending.length;
    const fresh = remaining > 0 ? await this.readNew(remaining, pending.length === 0 ? blockMs : 0) : [];
    const entries = await this.dropHandledUserMessages([...pending, ...fresh]);

    this.logFetch(blockMs, entries, startedAt);
    return entries;
  }

  /** Records that the runtime has these entries. They are settled by completeTick, not before. */
  handOff(entries: OutboundEntry[]): void {
    for (const entry of entries) this.handed.set(entry.streamId, entry);
  }

  /** Settles the entries handed over so far, according to how the tick ended. */
  async completeTick(outcome: TickOutcome): Promise<void> {
    if (outcome === 'held') return;
    if (this.handed.size === 0) return;
    const entries = [...this.handed.values()];
    this.handed.clear();

    if (outcome === 'failed') {
      await this.releaseFailed(entries);
      return;
    }

    const userEntries = entries.filter((entry) => this.messageIdOf(entry) !== null && isUserMessageType(entry.envelope['type']));
    try {
      await Promise.all(userEntries.map((entry) => this.redis.set(
        this.handledKey(this.messageIdOf(entry)!),
        '1',
        'EX',
        this.options.handledTtlSeconds,
      )));
    } catch (err) {
      logger.warn({ err, count: userEntries.length }, 'Could not record handled user messages; leaving entries pending');
      for (const entry of entries) this.handed.set(entry.streamId, entry);
      return;
    }

    await this.redis.xack(this.options.outboundStream, this.options.consumerGroup, ...entries.map((entry) => entry.streamId))
      .catch((err: unknown) => logger.warn({ err, count: entries.length }, 'Could not acknowledge handed outbound entries'));
  }

  /**
   * At startup, takes over every entry another consumer left pending. A restart gets a new consumer name, so the old
   * owner is not running. Claimed entries are not acknowledged, so the next fetch delivers them.
   */
  async claimStalePending(): Promise<number> {
    await this.ensureGroup();
    const { outboundStream: stream, consumerGroup: group, consumerName } = this.options;
    let claimed = 0;
    let start = '-';
    for (;;) {
      const rows = await this.redis.xpending(stream, group, start, '+', CLAIM_PAGE) as XPendingRow[];
      if (rows.length === 0) break;
      const foreign = rows.filter((row) => row[1] !== consumerName).map((row) => row[0]);
      if (foreign.length > 0) {
        const taken = await this.redis.xclaim(stream, group, consumerName, 0, ...foreign) as Array<[string, string[]] | null>;
        claimed += taken.filter((row) => row !== null).length;
      }
      if (rows.length < CLAIM_PAGE) break;
      start = `(${rows[rows.length - 1]![0]}`;
    }
    if (claimed > 0) logger.warn({ claimed }, 'Took over outbound entries left pending by a previous process');
    return claimed;
  }

  private async ensureGroup(): Promise<void> {
    if (this.groupReady) return;
    await this.redis.xgroup('CREATE', this.options.outboundStream, this.options.consumerGroup, '0', 'MKSTREAM').catch((err: unknown) => {
      if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
    });
    this.groupReady = true;
  }

  private async readPending(count: number): Promise<OutboundEntry[]> {
    const reply = await this.redis.xreadgroup(
      'GROUP', this.options.consumerGroup, this.options.consumerName,
      'COUNT', count,
      'STREAMS', this.options.outboundStream, '0',
    ) as XReadGroupReply;
    return this.parse(reply, true);
  }

  private async readNew(count: number, blockMs: number): Promise<OutboundEntry[]> {
    const reply = blockMs > 0
      ? await this.redis.xreadgroup(
        'GROUP', this.options.consumerGroup, this.options.consumerName,
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', this.options.outboundStream, '>',
      ) as XReadGroupReply
      : await this.redis.xreadgroup(
        'GROUP', this.options.consumerGroup, this.options.consumerName,
        'COUNT', count,
        'STREAMS', this.options.outboundStream, '>',
      ) as XReadGroupReply;
    return this.parse(reply, false);
  }

  /** Turns a read reply into entries. Deleted and malformed entries are acknowledged so they do not stay pending. */
  private async parse(reply: XReadGroupReply, skipHanded: boolean): Promise<OutboundEntry[]> {
    const entries: OutboundEntry[] = [];
    const toDrop: string[] = [];
    for (const [, items] of reply ?? []) {
      for (const [streamId, fields] of items) {
        if (skipHanded && this.handed.has(streamId)) continue;
        const envelopeIdx = fields ? fields.indexOf('envelope') : -1;
        const raw = fields && envelopeIdx >= 0 ? fields[envelopeIdx + 1] : undefined;
        let envelope: Record<string, unknown> | null = null;
        if (raw) {
          try {
            envelope = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            envelope = null;
          }
        }
        if (envelope) {
          entries.push({ streamId, envelope });
        } else {
          toDrop.push(streamId);
        }
      }
    }
    if (toDrop.length > 0) {
      await this.redis.xack(this.options.outboundStream, this.options.consumerGroup, ...toDrop).catch(() => { /* ignore */ });
    }
    return entries;
  }

  /** Drops user messages a completed tick has already handled (a replay after a crash), acknowledging them. */
  private async dropHandledUserMessages(entries: OutboundEntry[]): Promise<OutboundEntry[]> {
    const candidates = entries.filter((entry) => this.messageIdOf(entry) !== null && isUserMessageType(entry.envelope['type']));
    if (candidates.length === 0) return entries;

    const markers = await this.redis.mget(...candidates.map((entry) => this.handledKey(this.messageIdOf(entry)!)));
    const handled = new Set(candidates.filter((_, index) => markers[index] !== null).map((entry) => entry.streamId));
    if (handled.size === 0) return entries;

    await this.redis.xack(this.options.outboundStream, this.options.consumerGroup, ...handled)
      .catch((err: unknown) => logger.warn({ err }, 'Could not acknowledge already-handled user messages'));
    return entries.filter((entry) => !handled.has(entry.streamId));
  }

  /** Counts a failed tick against each of its entries. Entries past the limit are dead-lettered, the rest stay pending. */
  private async releaseFailed(entries: OutboundEntry[]): Promise<void> {
    let exhausted: OutboundEntry[] = [];
    try {
      const counts = await Promise.all(entries.map((entry) => this.redis.hincrby(this.options.attemptsKey, entry.streamId, 1)));
      await this.redis.expire(this.options.attemptsKey, ATTEMPTS_TTL_SECONDS);
      exhausted = entries.filter((_, index) => counts[index]! >= this.options.maxAttempts);
    } catch (err) {
      logger.warn({ err }, 'Could not count the failed tick; its entries stay pending');
    }

    if (exhausted.length > 0) await this.deadLetter(exhausted);
    logger.warn({ count: entries.length, deadLettered: exhausted.length }, 'Tick failed; outbound entries stay pending for the next read');
  }

  private async deadLetter(entries: OutboundEntry[]): Promise<void> {
    try {
      for (const entry of entries) {
        await this.redis.xadd(
          this.options.deadLetterStream, 'MAXLEN', '~', DEAD_LETTER_MAXLEN, '*',
          'envelope', JSON.stringify(entry.envelope),
          'streamId', entry.streamId,
          'reason', `failed ${this.options.maxAttempts} ticks`,
        );
      }
      await this.redis.xack(this.options.outboundStream, this.options.consumerGroup, ...entries.map((entry) => entry.streamId));
      logger.error({ streamIds: entries.map((entry) => entry.streamId).slice(0, LOGGED_IDS), count: entries.length }, 'Outbound entries dead-lettered after repeated failed ticks');
    } catch (err) {
      logger.error({ err }, 'Could not dead-letter outbound entries; they stay pending');
    }
  }

  private messageIdOf(entry: OutboundEntry): string | null {
    const id = entry.envelope['messageId'];
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private handledKey(messageId: string): string {
    return `${this.options.handledKeyPrefix}${messageId}`;
  }

  private logFetch(blockMs: number, entries: OutboundEntry[], startedAt: number): void {
    const elapsedMs = Date.now() - startedAt;
    const userStreamIds = entries.filter((entry) => isUserMessageType(entry.envelope['type'])).map((entry) => entry.streamId);
    const fields = {
      stream: this.options.outboundStream,
      group: this.options.consumerGroup,
      blockMs,
      count: entries.length,
      firstId: entries[0]?.streamId ?? null,
      lastId: entries[entries.length - 1]?.streamId ?? null,
      userMessageCount: userStreamIds.length,
      userMessageStreamIds: userStreamIds.slice(0, LOGGED_IDS),
      elapsedMs,
    };
    if (entries.length > 0 || elapsedMs >= SLOW_FETCH_MS) {
      logger.info(fields, 'Outbound read');
    } else {
      logger.debug(fields, 'Outbound read');
    }
  }
}

/**
 * The outcome of a tick that ran its body. A paused tick holds its entries; a tick that hit a runtime failure did not use
 * them; anything else used them.
 */
export function tickOutcome(state: { paused: boolean; failed: boolean }): TickOutcome {
  if (state.paused) return 'held';
  return state.failed ? 'failed' : 'completed';
}

/** Runs a tick and settles its entries with the outcome it reports. A throw counts as a failed tick and is rethrown. */
export async function settleTick(
  inbox: Pick<OutboundInbox, 'completeTick'>,
  run: () => Promise<TickOutcome>,
): Promise<TickOutcome> {
  let outcome: TickOutcome = 'failed';
  try {
    outcome = await run();
    return outcome;
  } finally {
    await inbox.completeTick(outcome);
  }
}

/** The group's `last-delivered-id`, or null when it cannot be read. Used only for diagnostics. */
export async function readGroupLastDeliveredId(redis: Redis, stream: string, group: string): Promise<string | null> {
  try {
    const groups = await redis.xinfo('GROUPS', stream) as unknown[][];
    for (const fields of groups) {
      const pairs = new Map<string, unknown>();
      for (let i = 0; i < fields.length; i += 2) pairs.set(String(fields[i]), fields[i + 1]);
      if (pairs.get('name') === group) return String(pairs.get('last-delivered-id'));
    }
    return null;
  } catch {
    return null;
  }
}

/** Orders two stream entry IDs (`<ms>-<seq>`) numerically. Negative when a < b. */
export function compareStreamIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  const ms = Number(aMs) - Number(bMs);
  return ms !== 0 ? ms : Number(aSeq) - Number(bSeq);
}
