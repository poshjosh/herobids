import type { ToolResult } from '@herobids/domain';

/**
 * Platform-side refresh of the portfolio block (bug 2026-11-21/002 item 3).
 *
 * Fills and position closes mark the account summary stale (a dirty flag); a quiet
 * period of `debounceMs` later ONE boundary read is folded in, however many fills the
 * burst held. A fill noted while a read is in flight is not lost: the flag is cleared
 * when a read starts, so a fill arriving mid-read leaves it set and one more read
 * follows (after the debounce). A decision wake also reads, at most once per
 * `debounceMs`, unless a fill is still waiting (then the wake read serves it, after
 * any in-flight read finishes). Nothing polls per tick.
 *
 * Failed reads: a read that returns an error, throws, or exceeds `readTimeoutMs` logs a
 * warning and leaves the previous portfolio state untouched (a late result is
 * discarded, never applied). A failure does not count as a success, so the next
 * decision wake retries; there is no retry loop in between.
 */
export interface PortfolioRefresherDeps {
  debounceMs: number;
  /** Upper bound on one read, covering everything the boundary client does not bound itself (account lookup, transport retries). */
  readTimeoutMs: number;
  /** Reads the account summary over the boundary; null when there is nothing to read (no trading account). */
  read: () => Promise<ToolResult | null>;
  /** Folds a successful summary payload into portfolio state. */
  apply: (data: unknown) => void;
  logger: { warn: (context: Record<string, unknown>, message: string) => void };
  now?: () => number;
}

export interface PortfolioRefresher {
  /** A fill or position close happened; schedule one read after the burst settles. */
  noteFill(): void;
  /** A decision wake is being processed; resolves once the read (if any) has been folded in. */
  refreshForWake(): Promise<void>;
  dispose(): void;
}

const FILL_JOURNAL_TYPES = new Set(['order.filled', 'order.partial', 'fill.recorded']);

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Event envelopes that signal a fill or a position close. Envelopes carry the event
 * body under `payload` (see InstanceEventPublisher); a flat body is tolerated.
 *
 * An execution result is a fill when it did not fail and either holds fills, or
 * closed the position (positionAfter is flat after orders were placed). A flat
 * position with no orders (a hold) is not a close.
 */
export function isFillOrCloseMessage(message: Record<string, unknown>): boolean {
  const type = message['type'];
  const rawPayload = message['payload'];
  const body = typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
    ? (rawPayload as Record<string, unknown>)
    : message;

  if (type === 'instance.execution.result') {
    if (body['executionFailed'] === true) return false;
    if (isNonEmptyArray(body['fills'])) return true;
    const positionAfter = body['positionAfter'];
    if (typeof positionAfter !== 'object' || positionAfter === null) return false;
    const { side, status } = positionAfter as Record<string, unknown>;
    return (side === 'flat' || status === 'closed') && isNonEmptyArray(body['orders']);
  }
  if (type === 'instance.journal.event') {
    const journalType = body['journalType'];
    return typeof journalType === 'string' && FILL_JOURNAL_TYPES.has(journalType);
  }
  return false;
}

export function createPortfolioRefresher(deps: PortfolioRefresherDeps): PortfolioRefresher {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSuccessAtMs = Number.NEGATIVE_INFINITY;
  let dirty = false;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = (): void => {
    clearTimer();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      // An in-flight read re-arms the timer itself on completion if still dirty.
      if (!inFlight) void readOnce();
    }, deps.debounceMs);
  };

  const readWithTimeout = async (): Promise<ToolResult | null> => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`Portfolio refresh read exceeded ${deps.readTimeoutMs}ms`)), deps.readTimeoutMs);
    });
    try {
      return await Promise.race([deps.read(), timeout]);
    } finally {
      clearTimeout(deadline);
    }
  };

  const readOnce = (): Promise<void> => {
    if (inFlight) return inFlight;
    dirty = false; // a fill noted from here on needs another read
    inFlight = (async () => {
      try {
        const result = await readWithTimeout();
        if (result === null) return;
        if (result.success) {
          deps.apply(result.data);
          lastSuccessAtMs = now();
        } else {
          deps.logger.warn({ errorCode: result.errorCode, error: result.error }, 'Portfolio refresh read failed — keeping previous state');
        }
      } catch (err) {
        deps.logger.warn({ err }, 'Portfolio refresh read failed or timed out — keeping previous state');
      } finally {
        inFlight = null;
        if (dirty) armTimer();
      }
    })();
    return inFlight;
  };

  return {
    noteFill() {
      dirty = true;
      armTimer();
    },
    async refreshForWake() {
      // A read already running may predate a fill; let it finish, then decide.
      if (inFlight) await inFlight;
      if (dirty || timer !== null) {
        // A fill is waiting; read now so this wake sees it.
        clearTimer();
        await readOnce();
        return;
      }
      if (now() - lastSuccessAtMs < deps.debounceMs) return;
      await readOnce();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
