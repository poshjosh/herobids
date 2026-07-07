// Sources that can trigger a shutdown when their per-source failure count reaches the threshold.
// Advisory sources (tick-gate, market-data, database, tool) degrade the runtime but never shut it down.
const SHUTDOWN_ELIGIBLE_SOURCES = new Set(['llm', 'redis', 'sandbox', 'startup']);

export interface FailureBackoffControllerOptions {
  baseIntervalMs: number;
  backoffThreshold?: number;
  maxFailures?: number;
  maxIntervalMs?: number;
}

export class FailureBackoffController {
  private consecutiveFailures = 0;
  private readonly sourceCounters = new Map<string, number>();

  constructor(private readonly options: FailureBackoffControllerOptions) {}

  recordFailure(source?: string): { consecutiveFailures: number; nextIntervalMs: number; shouldShutdown: boolean } {
    this.consecutiveFailures += 1;

    const sourceCount = source !== undefined
      ? (() => {
          const count = (this.sourceCounters.get(source) ?? 0) + 1;
          this.sourceCounters.set(source, count);
          return count;
        })()
      : this.consecutiveFailures;

    const maxFailures = this.options.maxFailures ?? 5;
    // Only shutdown-eligible sources (llm, redis, sandbox, startup) contribute to the shutdown gate.
    // Advisory sources (tick-gate, market-data, database, tool) back off but never trigger shutdown.
    const isShutdownEligible = source === undefined || SHUTDOWN_ELIGIBLE_SOURCES.has(source);
    const shouldShutdown = isShutdownEligible && sourceCount >= maxFailures;

    const nextIntervalMs = this.consecutiveFailures >= (this.options.backoffThreshold ?? 3)
      ? Math.min(this.options.baseIntervalMs * 2, this.options.maxIntervalMs ?? 1_800_000)
      : this.options.baseIntervalMs;
    return {
      consecutiveFailures: this.consecutiveFailures,
      nextIntervalMs,
      shouldShutdown,
    };
  }

  recordSuccess(): { recovered: boolean; nextIntervalMs: number } {
    const recovered = this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.sourceCounters.clear();
    return {
      recovered,
      nextIntervalMs: this.options.baseIntervalMs,
    };
  }
}

export interface ToolCircuitBreakerOptions {
  failureThreshold?: number;
  reopenAfterTicks?: number;
}

export function toolResultIndicatesFailure(toolResult: string): boolean {
  try {
    const parsed = JSON.parse(toolResult) as { ok?: boolean; fault?: boolean };
    return parsed.ok === false && parsed.fault !== false;
  } catch {
    return false;
  }
}

export class ToolCircuitBreaker {
  private readonly circuits = new Map<string, { failures: number; reopenAtTick: number | null }>();

  constructor(private readonly options: ToolCircuitBreakerOptions = {}) {}

  recordFailure(tool: string, currentTick: number): { opened: boolean; reopenAtTick: number | null } {
    const state = this.circuits.get(tool) ?? { failures: 0, reopenAtTick: null };
    state.failures += 1;
    const threshold = this.options.failureThreshold ?? 3;
    if (state.failures >= threshold && state.reopenAtTick === null) {
      state.reopenAtTick = currentTick + (this.options.reopenAfterTicks ?? 1);
    }
    this.circuits.set(tool, state);
    return { opened: state.reopenAtTick !== null && state.failures >= threshold, reopenAtTick: state.reopenAtTick };
  }

  recordSuccess(tool: string): void {
    const state = this.circuits.get(tool);
    if (!state) {
      return;
    }
    state.failures = 0;
    if (state.reopenAtTick === null) {
      this.circuits.set(tool, state);
    }
  }

  refresh(currentTick: number): { reopened: string[] } {
    const reopened: string[] = [];
    for (const [tool, state] of this.circuits) {
      if (state.reopenAtTick !== null && currentTick >= state.reopenAtTick) {
        state.failures = 0;
        state.reopenAtTick = null;
        reopened.push(tool);
      }
    }
    return { reopened };
  }

  getBlockedTools(currentTick: number): Set<string> {
    this.refresh(currentTick);
    return new Set(
      [...this.circuits.entries()]
        .filter(([, state]) => state.reopenAtTick !== null)
        .map(([tool]) => tool),
    );
  }
}

export function applyToolExclusions(
  tools: string[],
  exclusions: {
    permanent?: Set<string>;
    degraded?: Set<string>;
    circuit?: Set<string>;
  },
): string[] {
  return tools.filter((tool) => !exclusions.permanent?.has(tool) && !exclusions.degraded?.has(tool) && !exclusions.circuit?.has(tool));
}

// ── SessionCircuitBreaker ──────────────────────────────────────────────

export interface SessionCircuitBreakerOptions {
  enabled: boolean;
  strategyError: { maxInWindow: number; windowMs: number };
  drift: { maxInWindow: number; windowMs: number };
  streamDisconnect: { maxInWindow: number; windowMs: number };
  cooldownMs: number;
  maxTrips: number;
  probeIntervalMs: number;
}

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'TERMINATED';

/** Event categories that are tracked in sliding windows and can trip the breaker. */
const ERROR_EVENT_TYPES = new Set(['strategy_error', 'strategy_fatal', 'drift_detected', 'stream_disconnect']);

function isErrorEvent(eventType: string): boolean {
  return ERROR_EVENT_TYPES.has(eventType);
}

/** Recovery event — resets ALL counters and returns to CLOSED. */
const FILL_RECORDED = 'fill.recorded';
/** Recovery event — resets the drift counter. */
const DECISION_ACCEPTED = 'decision.accepted';
/** Recovery event — decrements the drift counter by one. */
const RECONCILIATION_MATCH = 'reconciliation.match';

interface TrackedEvent {
  timestamp: number;
  type: string;
}

export class SessionCircuitBreaker {
  private _state: BreakerState = 'CLOSED';
  private _tripCount = 0;
  private _events: TrackedEvent[] = [];
  private _cooldownStartedAt: number | null = null;

  constructor(private readonly options: SessionCircuitBreakerOptions) {}

  // ── public API ──────────────────────────────────────────────────────

  /**
   * Record a journal event and evaluate whether the breaker should trip.
   * Returns the post-transition state and flags for the caller.
   */
  record(eventType: string): { state: BreakerState; isOpen: boolean; shouldTerminate: boolean } {
    if (!this.options.enabled) {
      return { state: 'CLOSED', isOpen: false, shouldTerminate: false };
    }

    // Recovery events are processed before any state evaluation.
    // fill.recorded resets all counters but must not revive a TERMINATED session.
    if (eventType === FILL_RECORDED && this._state !== 'TERMINATED') {
      this.fullReset();
      return this.result();
    }
    if (eventType === DECISION_ACCEPTED) {
      this.removeAllDriftEvents();
      return this.result();
    }
    if (eventType === RECONCILIATION_MATCH) {
      this.removeOneDriftEvent();
      return this.result();
    }

    // If we are in OPEN and the cooldown has expired, transition to HALF_OPEN
    // before processing the new event. Track whether this call caused the
    // transition so the event that triggered it does NOT also fail the probe.
    let justEnteredHalfOpen = false;
    if (this._state === 'OPEN' && this.cooldownExpired()) {
      this._state = 'HALF_OPEN';
      this._cooldownStartedAt = null;
      justEnteredHalfOpen = true;
    }

    // Only track error-type events.
    if (isErrorEvent(eventType)) {
      this._events.push({ timestamp: Date.now(), type: eventType });
    }

    return this.evaluate(justEnteredHalfOpen);
  }

  /** True when the breaker is suppressing LLM (OPEN or TERMINATED). */
  isOpen(): boolean {
    return this._state === 'OPEN' || this._state === 'TERMINATED';
  }

  get state(): BreakerState {
    return this._state;
  }

  get tripCount(): number {
    return this._tripCount;
  }

  /** Reset all counters and return to CLOSED. */
  reset(): void {
    this.fullReset();
  }

  /**
   * Call when a HALF_OPEN probe tick completes successfully (no errors).
   * Transitions HALF_OPEN → CLOSED.
   */
  onProbeSuccess(): BreakerState {
    if (this._state === 'HALF_OPEN') {
      this._state = 'CLOSED';
    }
    return this._state;
  }

  /** Get cooldown timing info for the scheduler. */
  getCooldownStatus(): { inCooldown: boolean; remainingMs: number } {
    if (this._state !== 'OPEN' || this._cooldownStartedAt === null) {
      return { inCooldown: false, remainingMs: 0 };
    }
    const elapsed = Date.now() - this._cooldownStartedAt;
    const remainingMs = Math.max(0, this.options.cooldownMs - elapsed);
    return { inCooldown: true, remainingMs };
  }

  get probeIntervalMs(): number {
    return this.options.probeIntervalMs;
  }

  // ── internals ────────────────────────────────────────────────────────

  private fullReset(): void {
    this._state = 'CLOSED';
    this._tripCount = 0;
    this._events = [];
    this._cooldownStartedAt = null;
  }

  private removeAllDriftEvents(): void {
    this._events = this._events.filter((e) => e.type !== 'drift_detected');
  }

  private removeOneDriftEvent(): void {
    const idx = this._events.findIndex((e) => e.type === 'drift_detected');
    if (idx !== -1) {
      this._events.splice(idx, 1);
    }
  }

  private cooldownExpired(): boolean {
    if (this._cooldownStartedAt === null) return false;
    return Date.now() - this._cooldownStartedAt >= this.options.cooldownMs;
  }

  private result(): { state: BreakerState; isOpen: boolean; shouldTerminate: boolean } {
    return { state: this._state, isOpen: this.isOpen(), shouldTerminate: false };
  }

  /**
   * Evaluate the current state and events to determine if a transition is needed.
   * Called after a new error event has been appended.
   */
  private evaluate(justEnteredHalfOpen: boolean): { state: BreakerState; isOpen: boolean; shouldTerminate: boolean } {
    switch (this._state) {
      case 'TERMINATED':
        // Termination was already signaled during the transition — one-shot signal, not a persistent flag.
        return { state: 'TERMINATED', isOpen: true, shouldTerminate: false };

      case 'OPEN':
        // Already in OPEN — new events don't reset cooldown.
        return { state: 'OPEN', isOpen: true, shouldTerminate: false };

      case 'HALF_OPEN': {
        // An error event that arrives while we are already in HALF_OPEN fails the probe.
        // The event that triggered the OPEN→HALF_OPEN transition itself is exempt.
        if (!justEnteredHalfOpen) {
          const lastEvent = this._events[this._events.length - 1];
          if (lastEvent && isErrorEvent(lastEvent.type)) {
            return this.trip('probe failure');
          }
        }
        return { state: 'HALF_OPEN', isOpen: false, shouldTerminate: false };
      }

      case 'CLOSED': {
        // strategy_fatal trips immediately regardless of sliding windows.
        if (this.lastEventType() === 'strategy_fatal') {
          return this.trip('strategy_fatal');
        }
        if (this.anyThresholdBreached()) {
          return this.trip('threshold breached');
        }
        return { state: 'CLOSED', isOpen: false, shouldTerminate: false };
      }

      default:
        return { state: this._state, isOpen: this.isOpen(), shouldTerminate: false };
    }
  }

  /** Transition to OPEN (or TERMINATED if maxTrips exhausted). */
  private trip(reason: string): { state: BreakerState; isOpen: boolean; shouldTerminate: boolean } {
    this._tripCount += 1;
    this._cooldownStartedAt = Date.now();

    if (this._tripCount >= this.options.maxTrips) {
      this._state = 'TERMINATED';
      return { state: 'TERMINATED', isOpen: true, shouldTerminate: true };
    }

    this._state = 'OPEN';
    return { state: 'OPEN', isOpen: true, shouldTerminate: false };
  }

  private lastEventType(): string | undefined {
    if (this._events.length === 0) return undefined;
    return this._events[this._events.length - 1]!.type;
  }

  private countInWindow(eventType: string, windowMs: number): number {
    const now = Date.now();
    return this._events.filter((e) => e.type === eventType && now - e.timestamp <= windowMs).length;
  }

  private anyThresholdBreached(): boolean {
    return (
      this.countInWindow('strategy_error', this.options.strategyError.windowMs) > this.options.strategyError.maxInWindow ||
      this.countInWindow('drift_detected', this.options.drift.windowMs) > this.options.drift.maxInWindow ||
      this.countInWindow('stream_disconnect', this.options.streamDisconnect.windowMs) > this.options.streamDisconnect.maxInWindow
    );
  }
}