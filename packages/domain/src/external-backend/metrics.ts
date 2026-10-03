// The external-backend invocation metrics seam (see docs/tech/observability.md).
//
// A `MetricsSink` port plus a flat, serialisable `ExternalBackendInvocationSample`
// — the single way the platform measures external-backend tool invocations. Kept
// as pure types + a no-op default so the domain package stays I/O-free and this
// module remains barrel-safe (no node imports; the only import is the failure-code
// type from the boundary contract).
//
// The sink is a PORT, never a vendor: the client depends on this interface, not on
// a metrics library, so a pino / Prometheus / OpenTelemetry adapter can replace the
// default later with no change to the client or any caller.

import type { ExternalBackendFailureCode } from './contract.js';

/** One measured external-backend invocation. Flat and serialisable. */
export interface ExternalBackendInvocationSample {
  backendId: string; // which backend (e.g. "traderton")
  toolName: string; // the invoked tool
  outcome: 'success' | 'failure' | 'in_progress' | 'transport_error';
  code?: ExternalBackendFailureCode; // present only on 'failure'
  retryable?: boolean; // present on 'failure' / 'transport_error'
  durationMs: number; // end-to-end boundary latency for this invoke
  backendDurationMs?: number; // backend-reported internal time (Phase 2; reserved)
  requestId: string;
  correlationId: string;
}

/** The seam. The client calls this once per invocation; it must never throw. */
export interface MetricsSink {
  recordInvocation(sample: ExternalBackendInvocationSample): void;
}

/**
 * The domain default: a no-op sink. Any `ExternalBackendClient` built without a
 * sink (existing tests, incidental call sites) keeps working unchanged.
 */
export const NOOP_METRICS_SINK: MetricsSink = {
  recordInvocation(_sample: ExternalBackendInvocationSample): void {
    // intentionally empty — the no-op default records nothing.
  },
};
