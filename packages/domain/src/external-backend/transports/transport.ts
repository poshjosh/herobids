// The INTERNAL transport seam (Step 10 plan §2.4; P3-19). Not exported from the
// package subpath: only `ExternalBackendClient` and `select-transport.ts` use it.
//
// A transport translates ONE request to its wire format and decodes the answer.
// It owns no idempotency, retry policy, deadline arithmetic or result mapping —
// those stay in the client, so a transport swap cannot change them.

import type { ExternalBackendToolInvocationV1, ExternalBackendToolResultV1 } from '../contract.js';

/**
 * One invocation exactly as built by `ExternalBackendClient.buildEnvelope`.
 * I5: requestId and idempotencyKey are REQUIRED first-class inputs. A transport carries them on the
 * wire (REST: body; MCP: params._meta) and never mints, defaults, rewrites, re-orders or drops them.
 */
export type TransportInvocation = Readonly<ExternalBackendToolInvocationV1> & {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly deadlineAt: string;
};

/** Per-attempt options, computed ABOVE the seam (no deadline arithmetic below it). */
export interface TransportAttempt {
  readonly timeoutMs: number;
}

export interface TransportStatusAttempt extends TransportAttempt {
  readonly deadlineAt: string;
}

/** Wire-decoded, transport-neutral outcome of ONE request. Mapping to the client result stays in the client. */
export type TransportOutcome =
  | { kind: 'terminal'; result: ExternalBackendToolResultV1 }
  | { kind: 'in_progress'; requestId: string; correlationId: string }
  | { kind: 'transport_error'; message: string };

export interface ExternalBackendTransport {
  invoke(invocation: TransportInvocation, attempt: TransportAttempt): Promise<TransportOutcome>;
  /**
   * Optional capability: NON-executing status lookup by requestId alone (REST GET status).
   * Transports without one (MCP, D15) omit it; the client then resolves in_progress by a
   * same-key re-issue. Always call as `transport.lookupStatus(...)` (never detach — `this`).
   */
  lookupStatus?(requestId: string, attempt: TransportStatusAttempt): Promise<TransportOutcome>;
}
