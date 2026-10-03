// The worker-side SIDE-EFFECTING adapter for the Traderton REST boundary (L3c).
//
// Parallel to `read-adapter.ts`, but for the write/side-effecting tools
// (`submit_decision`, `create_bot`, `start_bot`, `stop_bot`,
// `adjust_bot_config`). It binds the concrete L3a `ExternalBackendClient` (which holds
// baseUrl, caller identity, and signing material) to a NARROW port the broker /
// decision-handler consume. Those consumers name a tool, forward an
// already-platform-gated payload, and supply the platform-owned subject VALUES
// (`ownerId` + `actor`). Unlike the read adapter — which serves a single agent
// container and binds one subject — the broker + decision handler run in the
// shared WORKER process and serve MANY agents, so the subject is supplied
// per-call (derived from the inbound envelope / the acting agent). The HMAC
// secret lives only in the `ExternalBackendClient`; it never reaches a consumer.
//
// Unlike the READ adapter (which maps to a domain-clean `TradertonReadResult`),
// the side-effecting consumers live in the worker and need the raw
// `ExternalBackendClientResult` so they can preserve the failure `code` + `retryable`
// verbatim when mapping onto the existing reply/event shapes. Transport +
// value-injection ONLY — no trading behaviour.
//
// Write idempotency (Phase 3 T0.6, D18). Every write carries a caller-supplied
// `idempotencyKey` (required on this port) naming ONE logical write; the client
// derives a stable `requestId` from it. The backend replays a stored terminal
// result for a known key, so a key is reused only while that write's outcome is
// unknown (`transport_error`, `in_progress`). A terminal outcome — success or
// failure, retryable or not — ends the key's life: a deliberate retry after a
// terminal failure is a new logical write with a new key, otherwise the stored
// failure is replayed forever.

import { randomUUID } from 'node:crypto';
import type { TradingToolContext } from '@herobids/domain';
import type {
  ExternalBackendClient,
  ExternalBackendClientResult,
  ExternalBackendSubject,
} from '@herobids/domain/external-backend';

/**
 * The narrow side-effecting boundary port. The caller identity + signing are
 * bound at construction; the consumer supplies a tool name, a validated payload,
 * the per-call platform subject, and the write's stable `idempotencyKey`.
 *
 * - `invoke` — a single signed `tools:invoke`. Returns the raw client result so
 *   the consumer can map `success`/`failure`/`in_progress`/`transport_error`
 *   (preserving `code`+`retryable`) onto its own reply/event shapes.
 * - `invokeAndAwait` — delegates to `ExternalBackendClient.invokeAndAwait`:
 *   invoke; on an unknown outcome (`transport_error`) while the deadline has
 *   not passed, re-issue ONCE with the identical input; then (if the boundary
 *   returned `in_progress`) resolve it until terminal or the deadline passes —
 *   a write still running at the deadline stays `in_progress` (unknown
 *   outcome). Reproduces the synchronous 30s-BLPOP feel the `submit_decision`
 *   path relies on (D3). The deadline is derived from `deadlineMs`.
 */
export interface TradertonSideEffectBoundary {
  invoke(input: {
    toolName: string;
    payload: unknown;
    subject: ExternalBackendSubject;
    /**
     * Stable and non-empty per logical write; reused only while its outcome is
     * unknown. An empty or whitespace-only key is rejected as
     * `validation.invalid_payload` without I/O.
     */
    idempotencyKey: string;
    requestId?: string;
    correlationId?: string;
  }): Promise<ExternalBackendClientResult>;
  invokeAndAwait(input: {
    toolName: string;
    payload: unknown;
    subject: ExternalBackendSubject;
    /** Total budget for invoke + poll, in ms. Derives the boundary `deadlineAt`. */
    deadlineMs: number;
    /** As on `invoke`: stable and non-empty per logical write. */
    idempotencyKey: string;
    requestId?: string;
    correlationId?: string;
  }): Promise<ExternalBackendClientResult>;
}

/** The subject-less write port a tool sees on its context (domain-owned shape). */
export type TradertonToolWriteBoundary = NonNullable<TradingToolContext['tradertonWriteBoundary']>;

/**
 * An empty or whitespace-only key is a caller programming error. It is rejected locally so it can
 * never become a key shared by unrelated writes; nothing was sent, so this is a
 * genuine terminal failure.
 */
function rejectEmptyIdempotencyKey(input: { requestId?: string; correlationId?: string }): ExternalBackendClientResult {
  return {
    kind: 'failure',
    requestId: input.requestId ?? '',
    correlationId: input.correlationId ?? '',
    code: 'validation.invalid_payload',
    message: 'idempotencyKey must be non-empty',
    retryable: false,
  };
}

/**
 * Build the side-effecting boundary adapter over a constructed `ExternalBackendClient`.
 * `invokeAndAwait` derives ONE `deadlineAt` from `deadlineMs`; the client uses
 * it for every attempt and for the in_progress resolution, so the boundary sees
 * one consistent deadline.
 */
export function createTradertonSideEffectBoundary(
  client: ExternalBackendClient,
): TradertonSideEffectBoundary {
  return {
    async invoke(input): Promise<ExternalBackendClientResult> {
      if (input.idempotencyKey.trim() === '') {
        return rejectEmptyIdempotencyKey(input);
      }
      return client.invoke({
        toolName: input.toolName,
        payload: input.payload,
        subject: input.subject,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
    },

    async invokeAndAwait(input): Promise<ExternalBackendClientResult> {
      if (input.idempotencyKey.trim() === '') {
        return rejectEmptyIdempotencyKey(input);
      }
      // The reconcile (same-key re-issue, in_progress resolution) lives in the
      // client, above the transport seam (P3-20).
      return client.invokeAndAwait({
        toolName: input.toolName,
        payload: input.payload,
        subject: input.subject,
        deadlineAt: new Date(Date.now() + input.deadlineMs).toISOString(),
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
      });
    },
  };
}

/**
 * Bind one subject to the side-effecting adapter for the agent-container tool
 * context. Tools stay key-less: each tool execution makes exactly one write
 * call, so a fresh key per call is one key per logical write. The key is not
 * persisted (container-local), so an unknown outcome is reconcilable in-call
 * only. Content-derived keys are deliberately NOT used: setting risk limits
 * A → B → A would replay the first A.
 */
export function createSubjectBoundWriteBoundary(
  boundary: TradertonSideEffectBoundary,
  subject: ExternalBackendSubject,
): TradertonToolWriteBoundary {
  return {
    invokeAndAwait: (input) =>
      boundary.invokeAndAwait({
        toolName: input.toolName,
        payload: input.payload,
        subject,
        deadlineMs: input.deadlineMs,
        idempotencyKey: randomUUID(),
      }),
  };
}
