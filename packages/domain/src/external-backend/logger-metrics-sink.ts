// A logger-backed `MetricsSink` adapter (see docs/tech/observability.md).
//
// The default sink: one structured log line per external-backend invocation,
// carrying the stable event tag `external_backend.invocation`. p50/p95/p99,
// throughput, and error-rate-by-code are computed offline from these lines.
//
// It takes a minimal structural `{ info(fields, msg) }` logger (pino-compatible,
// the same shape `AgentExternalBackendPortsLogger` already uses) rather than pino
// itself, so the domain package stays I/O-free: the apps inject their own
// `createLogger(...)`. Lives in domain so both apps/worker and apps/api can reach
// it without importing each other or pulling pino into domain.

import type { ExternalBackendInvocationSample, MetricsSink } from './metrics.js';

/**
 * Minimal structural logger this sink needs. Pino-compatible, but deliberately
 * NOT a pino import — domain stays dependency-free; the app injects the concrete
 * logger.
 */
export interface MetricsLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

/** Stable event tag for every emitted line — the offline aggregators key on it. */
const INVOCATION_EVENT = 'external_backend.invocation';

/**
 * Build a sink that emits exactly one `external_backend.invocation` line per
 * invocation. Undefined optional sample fields are omitted (no `code: undefined`
 * noise). Side-effect-only and non-throwing: constructing the fields cannot
 * throw, so there is no own try/catch (the client also wraps the call).
 */
export function createLoggerMetricsSink(logger: MetricsLogger): MetricsSink {
  return {
    recordInvocation(sample: ExternalBackendInvocationSample): void {
      const fields: Record<string, unknown> = {
        evt: INVOCATION_EVENT,
        backendId: sample.backendId,
        toolName: sample.toolName,
        outcome: sample.outcome,
        durationMs: sample.durationMs,
        requestId: sample.requestId,
        correlationId: sample.correlationId,
      };
      if (sample.code !== undefined) fields.code = sample.code;
      if (sample.retryable !== undefined) fields.retryable = sample.retryable;
      if (sample.backendDurationMs !== undefined) fields.backendDurationMs = sample.backendDurationMs;
      logger.info(fields, 'external-backend invocation');
    },
  };
}
