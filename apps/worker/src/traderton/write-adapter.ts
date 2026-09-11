// The worker-side SIDE-EFFECTING adapter for the Traderton REST boundary (L3c).
//
// Parallel to `read-adapter.ts`, but for the write/side-effecting tools
// (`submit_decision`, `create_bot`, `start_bot`, `stop_bot`,
// `adjust_bot_config`). It binds the concrete L3a `TradertonClient` (which holds
// baseUrl, caller identity, and signing material) to a NARROW port the broker /
// decision-handler consume. Those consumers name a tool, forward an
// already-platform-gated payload, and supply the platform-owned subject VALUES
// (`ownerId` + `actor`). Unlike the read adapter — which serves a single agent
// container and binds one subject — the broker + decision handler run in the
// shared WORKER process and serve MANY agents, so the subject is supplied
// per-call (derived from the inbound envelope / the acting agent). The HMAC
// secret lives only in the `TradertonClient`; it never reaches a consumer.
//
// Unlike the READ adapter (which maps to a domain-clean `TradertonReadResult`),
// the side-effecting consumers live in the worker and need the raw
// `TradertonClientResult` so they can preserve the failure `code` + `retryable`
// verbatim when mapping onto the existing reply/event shapes. Transport +
// value-injection ONLY — no trading behaviour.

import type { TradertonClient, TradertonClientResult, TradertonSubject } from '@herobids/domain/traderton';

/**
 * The narrow side-effecting boundary port. The caller identity + signing are
 * bound at construction; the consumer supplies a tool name, a validated payload,
 * and the per-call platform subject.
 *
 * - `invoke` — a single signed `tools:invoke`. Returns the raw client result so
 *   the consumer can map `success`/`failure`/`in_progress`/`transport_error`
 *   (preserving `code`+`retryable`) onto its own reply/event shapes.
 * - `invokeAndAwait` — invoke, then (if the boundary returned `in_progress`)
 *   poll `GET invocations/:requestId` until terminal or the deadline passes.
 *   Reproduces the synchronous 30s-BLPOP feel the `submit_decision` path relies
 *   on (D3). The deadline is derived from `deadlineMs`.
 */
export interface TradertonSideEffectBoundary {
  invoke(input: {
    toolName: string;
    payload: unknown;
    subject: TradertonSubject;
  }): Promise<TradertonClientResult>;
  invokeAndAwait(input: {
    toolName: string;
    payload: unknown;
    subject: TradertonSubject;
    /** Total budget for invoke + poll, in ms. Derives the boundary `deadlineAt`. */
    deadlineMs: number;
  }): Promise<TradertonClientResult>;
}

/**
 * Build the side-effecting boundary adapter over a constructed `TradertonClient`.
 * `invokeAndAwait` uses the SAME `deadlineAt` for both the invoke envelope and
 * the poll loop so the boundary sees one consistent deadline.
 */
export function createTradertonSideEffectBoundary(
  client: TradertonClient,
): TradertonSideEffectBoundary {
  return {
    async invoke(input): Promise<TradertonClientResult> {
      return client.invoke({
        toolName: input.toolName,
        payload: input.payload,
        subject: input.subject,
      });
    },

    async invokeAndAwait(input): Promise<TradertonClientResult> {
      const deadlineAt = new Date(Date.now() + input.deadlineMs).toISOString();
      const result = await client.invoke({
        toolName: input.toolName,
        payload: input.payload,
        subject: input.subject,
        deadlineAt,
      });

      // The boundary reached a terminal outcome (or a transport failure) already.
      if (result.kind !== 'in_progress') {
        return result;
      }

      // Non-terminal — poll to the shared deadline for the synchronous feel (D3).
      return client.poll(result.requestId, { deadlineAt, correlationId: result.correlationId });
    },
  };
}
