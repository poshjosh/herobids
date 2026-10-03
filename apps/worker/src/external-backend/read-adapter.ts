// The worker-side read adapter for the Traderton REST boundary (L3b).
//
// It bridges the concrete L3a `ExternalBackendClient` (which holds baseUrl, caller
// identity, and signing material) to the domain-clean `externalBackend` port
// on `TradingToolContext`. The read tools name a tool + forward a validated
// payload; this adapter binds the platform-owned subject VALUES + the deadline
// and maps the client's `ExternalBackendClientResult` into the domain
// `ExternalBackendReadResult`. Transport/value-injection ONLY — no trading behaviour.
//
// The HMAC secret lives only in the `ExternalBackendClient`; it never reaches the
// tool or the domain port.

import type { ExternalBackendReadResult } from '@herobids/domain';
import type { ExternalBackendClient, ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';

/** The narrow port the read tools consume via `ctx.externalBackend`. */
export interface ExternalBackendReadBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<ExternalBackendReadResult>;
}

/** Map a concrete L3a client result into the domain-clean read result. */
export function mapClientResultToReadResult(result: ExternalBackendClientResult): ExternalBackendReadResult {
  switch (result.kind) {
    case 'success':
      return { kind: 'success', data: result.payload };
    case 'failure':
      return {
        kind: 'failure',
        code: result.code,
        message: result.message,
        retryable: result.retryable,
      };
    case 'in_progress':
      return { kind: 'in_progress' };
    case 'transport_error':
      return { kind: 'transport_error', message: result.message, retryable: true };
  }
}

/**
 * Build the read boundary adapter. The subject VALUES + per-request deadline are
 * bound here (from the composition root), so the tool only supplies a tool name
 * + payload. A read is a single synchronous invoke within `deadlineMs` — it does
 * NOT poll (polling is the L3c side-effecting concern).
 */
export function createExternalBackendReadBoundary(
  client: ExternalBackendClient,
  subject: ExternalBackendSubject,
  deadlineMs: number,
): ExternalBackendReadBoundary {
  return {
    async invoke(input: { toolName: string; payload: unknown }): Promise<ExternalBackendReadResult> {
      const result = await client.invoke({
        toolName: input.toolName,
        payload: input.payload,
        subject,
        deadlineMs,
      });
      return mapClientResultToReadResult(result);
    },
  };
}
