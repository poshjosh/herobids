import { classifyRuntimeError, type RuntimeFailureSource } from './runtime-errors.js';
import type { FailureBackoffController } from './runtime-resilience.js';
import type { RuntimeDependency } from './runtime-tool-visibility.js';

type HeartbeatStatus = 'starting' | 'ready' | 'busy' | 'degraded';

export async function processRuntimeFailure(
  source: RuntimeFailureSource,
  error: unknown,
  options: {
    failureBackoff: FailureBackoffController;
    effectiveTickIntervalMs: number;
    setDependencyAvailability: (dependency: RuntimeDependency, available: boolean) => void;
    sendHeartbeat: (status: HeartbeatStatus, reasonCode?: string) => Promise<void>;
    shutdown: (reason: string) => Promise<void>;
    onBackoff?: (info: { consecutiveFailures: number; nextIntervalMs: number }) => void;
  },
): Promise<{
  classification: ReturnType<typeof classifyRuntimeError>;
  nextTickIntervalMs: number;
  shouldShutdown: boolean;
}> {
  const classification = classifyRuntimeError(source, error);

  if (classification.reasonCode === 'database.unavailable') {
    options.setDependencyAvailability('database', false);
  }
  if (classification.reasonCode === 'market_data.unavailable') {
    options.setDependencyAvailability('market-data', false);
  }

  const failureState = options.failureBackoff.recordFailure();
  let nextTickIntervalMs = options.effectiveTickIntervalMs;

  if (classification.mode === 'fatal' || failureState.shouldShutdown) {
    await options.sendHeartbeat('degraded', classification.reasonCode);
    await options.shutdown(classification.reasonCode === 'sandbox.expired' ? 'wall_clock_expired' : classification.reasonCode);
    return { classification, nextTickIntervalMs, shouldShutdown: true };
  }

  if (failureState.consecutiveFailures >= 3) {
    nextTickIntervalMs = Math.max(nextTickIntervalMs, failureState.nextIntervalMs);
    options.onBackoff?.({
      consecutiveFailures: failureState.consecutiveFailures,
      nextIntervalMs: nextTickIntervalMs,
    });
  }

  await options.sendHeartbeat('degraded', classification.reasonCode);
  return { classification, nextTickIntervalMs, shouldShutdown: false };
}