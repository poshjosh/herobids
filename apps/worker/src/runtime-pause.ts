/**
 * Runtime-side pause handling (bug 2026-10-05/001).
 *
 * Pause and resume only write `agents.status` in Postgres; nothing notifies the
 * running container. The runtime therefore polls the status itself and, while
 * paused, does no decision work. This module holds the pure parts so they can be
 * unit tested without loading `agent.ts` (which has top-level side effects).
 */
import { AGENT_WAKE_TYPE, isUserMessageType } from './tick-gate-state.js';

export const PAUSED_AGENT_STATUS = 'paused';
export const PAUSED_TICK_GATE = 'paused';
export const PAUSED_TICK_REASON = 'agent_paused';
const CONFIG_UPDATE_TYPE = 'agent.runtime.config_update';

export type PauseTransition = 'paused' | 'resumed' | null;

export interface PauseRefreshResult {
  paused: boolean;
  /** Set only when the pause state changed on this refresh. */
  transition: PauseTransition;
}

export interface PauseStateTrackerOptions {
  /** Reads `agents.status`. Null when the runtime has no DB access (treated as never paused). */
  readStatus: (() => Promise<string | null>) | null;
  /** Called when a status read fails; the last-known state is kept. */
  onReadError: (err: unknown) => void;
}

export interface PauseStateTracker {
  isPaused(): boolean;
  refresh(): Promise<PauseRefreshResult>;
}

export function createPauseStateTracker(options: PauseStateTrackerOptions): PauseStateTracker {
  let paused = false;

  return {
    isPaused: () => paused,
    async refresh(): Promise<PauseRefreshResult> {
      if (!options.readStatus) {
        return { paused: false, transition: null };
      }
      let status: string | null;
      try {
        status = await options.readStatus();
      } catch (err) {
        // Transient DB error: never flip state on a failed read.
        options.onReadError(err);
        return { paused, transition: null };
      }
      // A missing row is not treated as paused (same rule as the decision handler).
      const nextPaused = status === PAUSED_AGENT_STATUS;
      const transition: PauseTransition = nextPaused === paused ? null : (nextPaused ? 'paused' : 'resumed');
      paused = nextPaused;
      return { paused, transition };
    },
  };
}

/** While paused, re-check status at min(normal tick interval, status poll interval). */
export function resolvePausedTickDelay(requestedDelayMs: number, statusPollMs: number): number {
  return Math.min(requestedDelayMs, statusPollMs);
}

/** User messages and config updates must survive held-queue overflow. */
export function isPriorityHeldMessage(message: Record<string, unknown>): boolean {
  const type = message['type'];
  return isUserMessageType(type) || type === CONFIG_UPDATE_TYPE;
}

/**
 * Wake envelopes read while paused are dropped, not held: replaying them on
 * resume would present a possibly hours-old market signal to the LLM as current.
 */
export function shouldHoldWhilePaused(message: Record<string, unknown>): boolean {
  return message['type'] !== AGENT_WAKE_TYPE;
}

export type PausedWakeAction = 'suppress' | 'flag_user_message' | 'pass_through';

/**
 * How the wake poller treats an envelope while paused: market wakes are ACKed
 * and suppressed; user messages only set the pending flag (no early tick).
 */
export function resolvePausedWakeAction(type: unknown): PausedWakeAction {
  if (type === AGENT_WAKE_TYPE) return 'suppress';
  if (isUserMessageType(type)) return 'flag_user_message';
  return 'pass_through';
}

export interface PauseGatedTickDeps {
  tracker: PauseStateTracker;
  heldMessages: HeldMessageQueue;
  /** Full (non-paused) tick body. `resumed` is true on the first tick after a pause. */
  runActiveTick: (options: { resumed: boolean }) => Promise<void>;
  isSessionExpired: () => boolean;
  shutdownExpired: () => Promise<void>;
  readOutboundMessages: () => Promise<Array<Record<string, unknown>>>;
  emitPausedSkip: () => void;
  /** Called once per paused transition (log + discard buffered wake state). */
  onPauseEntered: () => void;
  onHeldOverflow: (droppedOverflow: number) => void;
  onPausedReadError: (err: unknown) => void;
}

/**
 * Tick entry point with the pause gate in front. While paused it performs only
 * the paused-tick duties (expiry, stream consumption into the held queue,
 * tick_skipped event); otherwise it runs the full tick body.
 */
export async function runPauseGatedTick(deps: PauseGatedTickDeps): Promise<'paused' | 'active'> {
  const refresh = await deps.tracker.refresh();
  if (!refresh.paused) {
    await deps.runActiveTick({ resumed: refresh.transition === 'resumed' });
    return 'active';
  }

  if (deps.isSessionExpired()) {
    await deps.shutdownExpired();
    return 'paused';
  }
  if (refresh.transition === 'paused') {
    deps.onPauseEntered();
  }

  try {
    const messages = await deps.readOutboundMessages();
    const result = deps.heldMessages.push(messages);
    if (result.droppedOverflow > 0) {
      deps.onHeldOverflow(result.droppedOverflow);
    }
  } catch (err) {
    deps.onPausedReadError(err);
  }

  deps.emitPausedSkip();
  return 'paused';
}

export interface HeldMessagePushResult {
  held: number;
  droppedWakes: number;
  droppedOverflow: number;
}

/**
 * Bounded FIFO of outbound messages read while paused. Drained, in original
 * order, into the first non-paused tick. On overflow the oldest non-priority
 * messages are dropped first; priority messages are always kept.
 */
export class HeldMessageQueue {
  private messages: Array<Record<string, unknown>> = [];

  constructor(private readonly maxMessages: number) {}

  get size(): number {
    return this.messages.length;
  }

  push(incoming: ReadonlyArray<Record<string, unknown>>): HeldMessagePushResult {
    let droppedWakes = 0;
    for (const message of incoming) {
      if (shouldHoldWhilePaused(message)) {
        this.messages.push(message);
      } else {
        droppedWakes++;
      }
    }

    let droppedOverflow = 0;
    let excess = this.messages.length - this.maxMessages;
    if (excess > 0) {
      const kept: Array<Record<string, unknown>> = [];
      for (const message of this.messages) {
        if (excess > 0 && !isPriorityHeldMessage(message)) {
          excess--;
          droppedOverflow++;
          continue;
        }
        kept.push(message);
      }
      this.messages = kept;
    }

    return { held: incoming.length - droppedWakes, droppedWakes, droppedOverflow };
  }

  drain(): Array<Record<string, unknown>> {
    const drained = this.messages;
    this.messages = [];
    return drained;
  }
}
