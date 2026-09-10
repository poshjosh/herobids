// The worker-side read adapter for the Traderton REST boundary (L3b).
//
// It bridges the concrete L3a `TradertonClient` (which holds baseUrl, caller
// identity, and signing material) to the domain-clean `tradertonBoundary` port
// on `TradingToolContext`. The read tools name a tool + forward a validated
// payload; this adapter binds the platform-owned subject VALUES + the deadline
// and maps the client's `TradertonClientResult` into the domain
// `TradertonReadResult`. Transport/value-injection ONLY — no trading behaviour.
//
// The HMAC secret lives only in the `TradertonClient`; it never reaches the
// tool or the domain port.

import type { TradertonReadResult } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult } from './client.js';
import type { TradertonSubject } from './contract.js';

/** The narrow port the read tools consume via `ctx.tradertonBoundary`. */
export interface TradertonReadBoundary {
  invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult>;
}

/** Map a concrete L3a client result into the domain-clean read result. */
export function mapClientResultToReadResult(result: TradertonClientResult): TradertonReadResult {
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
export function createTradertonReadBoundary(
  client: TradertonClient,
  subject: TradertonSubject,
  deadlineMs: number,
): TradertonReadBoundary {
  return {
    async invoke(input: { toolName: string; payload: unknown }): Promise<TradertonReadResult> {
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
