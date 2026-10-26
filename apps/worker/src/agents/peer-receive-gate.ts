import type { PeerDropDetail, PeerMessagingStatePort } from '@herobids/domain';
import { AGENT_USER_MESSAGE_TYPE } from '../tick-gate-state.js';

export interface PeerReceiveGateLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The operator's `agentRuntime.peer.switch*` settings. */
export interface PeerReceiveGateOptions {
  /** How long one read of the switch is reused. 0 reads every time. */
  cacheMs: number;
  /** Extra attempts after a failed read, before the message is dropped. */
  readRetries: number;
  /** Wait between attempts. */
  retryBackoffMs: number;
  /** Upper bound on one `check`, so a stalled read cannot hold a tick. A check that runs over it fails closed. Unbounded when unset. */
  maxWaitMs?: number;
}

/** What the receiving agent reports about a message it dropped (never the text). */
export interface PeerDropReport {
  messageId: string;
  fromAgentId: string;
  reason: PeerDropDetail;
}

/** Reports a drop to the platform so the thread row can be marked `refused` (DEC-57 c). Best effort; may reject. */
export type PeerDropReporter = (report: PeerDropReport) => Promise<void>;

/** `open` when peer messages may be accepted now, otherwise why they are dropped. */
export type PeerSwitchVerdict = 'open' | PeerDropDetail;

/** Ids already reported by this process, so a wake and the tick that follows it report one drop once. Bounded. */
const REPORTED_DROPS_MAX = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True for an `agent.user.message` that carries `payload.peer`, valid or not. Anything that claims to be a peer message
 * is held to the stop switch, so a malformed one cannot slip past as an ordinary user message.
 */
export function isPeerEnvelope(message: Record<string, unknown>): boolean {
  if (message['type'] !== AGENT_USER_MESSAGE_TYPE) return false;
  const payload = message['payload'];
  return typeof payload === 'object' && payload !== null && 'peer' in payload;
}

/** The thread row id and the sender of a peer envelope; null when the envelope is too malformed to name them. */
function dropTarget(message: Record<string, unknown>): { messageId: string; fromAgentId: string } | null {
  const messageId = message['messageId'];
  const payload = message['payload'];
  const peer = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['peer'] : undefined;
  const fromAgentId = typeof peer === 'object' && peer !== null ? (peer as Record<string, unknown>)['fromAgentId'] : undefined;
  return typeof messageId === 'string' && messageId !== '' && typeof fromAgentId === 'string' && fromAgentId !== ''
    ? { messageId, fromAgentId }
    : null;
}

/**
 * The receiving side of the owner's stop switch (DEC-43, DEC-56, DEC-57). A peer message that was already queued on the
 * stream when the owner paused peer messaging is dropped here, as the agent consumes it, and its thread row is reported as
 * refused with `paused`. When the switch cannot be read (after the configured retries) or the agent has no platform
 * client, the message is dropped too (fail closed, I4), reported as `paused_check_failed`. One read is reused for
 * `cacheMs`, and concurrent callers share an in-flight read. A failed read is not cached. Message text is never logged.
 */
export class PeerReceiveGate {
  private cached: { verdict: PeerSwitchVerdict; at: number } | null = null;
  private inFlight: Promise<PeerSwitchVerdict> | null = null;
  private readonly reported = new Set<string>();

  constructor(
    private readonly state: PeerMessagingStatePort | undefined,
    private readonly log: PeerReceiveGateLog,
    private readonly options: PeerReceiveGateOptions,
    private readonly report?: PeerDropReporter,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** The current state of the switch, from the cache when it is fresh. Never rejects. */
  async check(): Promise<PeerSwitchVerdict> {
    if (this.cached && this.now() - this.cached.at < this.options.cacheMs) return this.cached.verdict;
    this.inFlight ??= this.read().finally(() => { this.inFlight = null; });
    return this.options.maxWaitMs === undefined ? this.inFlight : this.withinDeadline(this.inFlight, this.options.maxWaitMs);
  }

  /** True when the message may be consumed. A peer message the switch refuses is logged and reported as dropped. */
  async admits(message: Record<string, unknown>): Promise<boolean> {
    if (!isPeerEnvelope(message)) return true;
    const verdict = await this.check();
    if (verdict === 'open') return true;
    await this.drop(verdict, [message]);
    return false;
  }

  /** The messages without the peer messages the switch refuses. One check per call, and none without a peer message. */
  async filter(messages: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
    if (!messages.some(isPeerEnvelope)) return messages;
    const verdict = await this.check();
    if (verdict === 'open') return messages;
    await this.drop(verdict, messages.filter(isPeerEnvelope));
    return messages.filter((message) => !isPeerEnvelope(message));
  }

  private async read(): Promise<PeerSwitchVerdict> {
    if (!this.state) {
      this.log.warn({ reason: 'no_platform_client' }, 'Peer message check failed: the stop switch cannot be read');
      return 'paused_check_failed';
    }
    const attempts = this.options.readRetries + 1;
    let failure = 'unreadable';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.wait(this.options.retryBackoffMs);
      try {
        const result = await this.state.getPeerMessagingState();
        if (result.ok) {
          const verdict: PeerSwitchVerdict = result.data.paused ? 'paused' : 'open';
          this.cached = { verdict, at: this.now() };
          return verdict;
        }
        failure = result.error.code;
        // A refusal that repeating cannot change (the key is refused, the agent is unknown) is not retried.
        if (!result.error.retryable) break;
      } catch {
        failure = 'threw';
      }
    }
    this.log.warn({ reason: 'unreadable', failure, attempts }, 'Peer message check failed: the stop switch cannot be read');
    return 'paused_check_failed';
  }

  private withinDeadline(read: Promise<PeerSwitchVerdict>, ms: number): Promise<PeerSwitchVerdict> {
    return new Promise<PeerSwitchVerdict>((resolve) => {
      const timer = setTimeout(() => {
        this.log.warn({ reason: 'unreadable', failure: 'timeout', maxWaitMs: ms }, 'Peer message check failed: the stop switch read took too long');
        resolve('paused_check_failed');
      }, ms);
      void read.then((verdict) => {
        clearTimeout(timer);
        resolve(verdict);
      });
    });
  }

  private async drop(reason: PeerDropDetail, dropped: Array<Record<string, unknown>>): Promise<void> {
    this.log.warn(
      { reason, count: dropped.length },
      reason === 'paused'
        ? 'Dropping peer message: the owner has paused agent-to-agent messaging'
        : 'Dropping peer message: the stop switch could not be read',
    );
    if (!this.report) return;
    for (const message of dropped) {
      const target = dropTarget(message);
      if (!target || this.reported.has(target.messageId)) continue;
      if (this.reported.size >= REPORTED_DROPS_MAX) this.reported.clear();
      this.reported.add(target.messageId);
      try {
        await this.report({ ...target, reason });
      } catch (error) {
        this.log.warn({ messageId: target.messageId, cause: error instanceof Error ? error.name : 'NonError' }, 'Dropped peer message could not be reported');
      }
    }
  }
}
