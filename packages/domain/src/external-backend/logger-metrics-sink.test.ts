import { describe, it, expect } from 'vitest';
import { createLoggerMetricsSink, type MetricsLogger } from './logger-metrics-sink.js';
import type { ExternalBackendInvocationSample } from './metrics.js';

interface CapturedLine {
  fields: Record<string, unknown>;
  message: string;
}

function createCapturingLogger(): { logger: MetricsLogger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger: MetricsLogger = {
    info(fields: Record<string, unknown>, message: string): void {
      lines.push({ fields, message });
    },
  };
  return { logger, lines };
}

const SUCCESS_SAMPLE: ExternalBackendInvocationSample = {
  backendId: 'traderton',
  toolName: 'get_price',
  outcome: 'success',
  durationMs: 118,
  requestId: 'req-1',
  correlationId: 'corr-1',
};

describe('createLoggerMetricsSink', () => {
  it('emits one external_backend.invocation line carrying the sample fields', () => {
    const { logger, lines } = createCapturingLogger();
    const sink = createLoggerMetricsSink(logger);

    sink.recordInvocation(SUCCESS_SAMPLE);

    expect(lines).toHaveLength(1);
    const { fields } = lines[0]!;
    expect(fields.evt).toBe('external_backend.invocation');
    expect(fields.backendId).toBe('traderton');
    expect(fields.toolName).toBe('get_price');
    expect(fields.outcome).toBe('success');
    expect(fields.durationMs).toBe(118);
    expect(fields.requestId).toBe('req-1');
    expect(fields.correlationId).toBe('corr-1');
  });

  it('omits undefined optional fields', () => {
    const { logger, lines } = createCapturingLogger();
    const sink = createLoggerMetricsSink(logger);

    sink.recordInvocation(SUCCESS_SAMPLE);

    const { fields } = lines[0]!;
    expect(fields).not.toHaveProperty('code');
    expect(fields).not.toHaveProperty('retryable');
    expect(fields).not.toHaveProperty('backendDurationMs');
  });

  it('includes code and retryable for a failure sample', () => {
    const { logger, lines } = createCapturingLogger();
    const sink = createLoggerMetricsSink(logger);
    const failureSample: ExternalBackendInvocationSample = {
      backendId: 'traderton',
      toolName: 'adjust_risk_limits',
      outcome: 'failure',
      code: 'authorization.denied',
      retryable: false,
      durationMs: 42,
      requestId: 'req-2',
      correlationId: 'corr-2',
    };

    sink.recordInvocation(failureSample);

    const { fields } = lines[0]!;
    expect(fields.code).toBe('authorization.denied');
    expect(fields.retryable).toBe(false);
  });
});
