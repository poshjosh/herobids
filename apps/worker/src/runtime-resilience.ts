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

export class ToolCircuitBreaker {
  private readonly circuits = new Map<string, { failures: number; reopenAtTick: number | null }>();

  constructor(private readonly options: ToolCircuitBreakerOptions = {}) {}

  recordFailure(tool: string, currentTick: number): { opened: boolean; reopenAtTick: number | null } {
    const state = this.circuits.get(tool) ?? { failures: 0, reopenAtTick: null };
    state.failures += 1;
    const threshold = this.options.failureThreshold ?? 3;
    if (state.failures >= threshold && state.reopenAtTick === null) {
      state.reopenAtTick = currentTick + (this.options.reopenAfterTicks ?? 5);
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