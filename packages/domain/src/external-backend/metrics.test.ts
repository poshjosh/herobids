import { describe, it, expect } from 'vitest';
import { NOOP_METRICS_SINK, type ExternalBackendInvocationSample } from './metrics.js';

describe('NOOP_METRICS_SINK', () => {
  it('no-op sink accepts a sample without throwing', () => {
    const sample: ExternalBackendInvocationSample = {
      backendId: 'traderton',
      toolName: 'get_price',
      outcome: 'success',
      durationMs: 118,
      requestId: 'req-1',
      correlationId: 'corr-1',
    };
    expect(() => NOOP_METRICS_SINK.recordInvocation(sample)).not.toThrow();
    expect(NOOP_METRICS_SINK.recordInvocation(sample)).toBeUndefined();
  });
});
