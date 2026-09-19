// Shared mapping from a Traderton boundary read result to a tool `ToolResult`
// (L3b §3c). All five rewired read tools use this so the mapping stays DRY and
// consistent: success carries the boundary payload through unchanged; typed
// failures preserve code/retryable and derive fault from whether the failure is
// content-level (validation/not-found) or infrastructure; in_progress and
// transport_error become typed retryable failures rather than raw throws.

import type { ToolResult, TradertonReadResult } from '@herobids/domain';
import type { TradertonClientResult } from '@herobids/domain/traderton';

/**
 * Boundary failure codes that are content-level outcomes (the request was
 * understood; the answer is "invalid" or "absent"). These do NOT count against
 * the tool's circuit breaker, so `fault:false`. Every other failure code is an
 * infrastructure/internal fault (`fault:true`).
 *
 * A3: `precondition.not_ready` joins the set — the boundary now surfaces typed
 * tool-level preconditions on READS too (get_risk_limits without an attached
 * risk spec; adjust_risk_limits' fail-closed). These are "not yet" outcomes, not
 * infrastructure faults, and must not trip the tool circuit breaker.
 */
const CONTENT_LEVEL_FAILURE_CODES = new Set<string>([
  'validation.invalid_payload',
  'not_found.resource',
  'precondition.not_ready',
]);

/**
 * Content-level failure codes for the WRITE path. Adds `precondition.not_ready`
 * to the read set: a not-ready precondition on a mutation is a content-level
 * "not yet" outcome (subject/state not provisioned), not an infrastructure
 * fault — it must not count against the tool's circuit breaker.
 */
const WRITE_CONTENT_LEVEL_FAILURE_CODES = new Set<string>([
  ...CONTENT_LEVEL_FAILURE_CODES,
  'precondition.not_ready',
  'authorization.denied',
]);

/** Map a `TradertonReadResult` into the tool contract's `ToolResult`. */
export function mapReadResultToToolResult(result: TradertonReadResult): ToolResult {
  switch (result.kind) {
    case 'success':
      return { success: true, data: result.data };
    case 'failure':
      return {
        success: false,
        error: result.message,
        errorCode: result.code,
        retryable: result.retryable,
        fault: !CONTENT_LEVEL_FAILURE_CODES.has(result.code),
      };
    case 'in_progress':
      // A read should be synchronous; treat an unexpected in-progress as a
      // transient, content-level (non-fault) failure so a retry may resolve it.
      return {
        success: false,
        error: 'boundary invocation still in progress',
        errorCode: 'boundary.in_progress',
        retryable: true,
        fault: false,
      };
    case 'transport_error':
      return {
        success: false,
        error: 'trading boundary is unreachable',
        errorCode: 'boundary.transport_error',
        retryable: true,
        fault: true,
      };
  }
}

/**
 * Map a side-effecting boundary result (`TradertonClientResult`, the raw client
 * union) into the tool contract's `ToolResult` (L3d). Parallel to
 * {@link mapReadResultToToolResult} but for the write path:
 *
 * - `success` carries the boundary payload through unchanged (the boundary
 *   returns the same success shape the tool used to build in-process, so parity
 *   holds by construction).
 * - `failure` preserves `code`/`retryable` verbatim; `fault` is derived from
 *   whether the failure is content-level (validation/not-found/precondition)
 *   rather than an infrastructure fault.
 * - `in_progress` becomes a `precondition.not_ready` failure — a synchronous
 *   write that never reached a terminal outcome within the deadline is treated
 *   as not-ready (non-fault; a retry may resolve it).
 * - `transport_error` becomes a retryable infrastructure fault.
 */
export function mapWriteResultToToolResult(result: TradertonClientResult): ToolResult {
  switch (result.kind) {
    case 'success':
      return { success: true, data: result.payload };
    case 'failure':
      return {
        success: false,
        error: result.message,
        errorCode: result.code,
        retryable: result.retryable,
        fault: !WRITE_CONTENT_LEVEL_FAILURE_CODES.has(result.code),
      };
    case 'in_progress':
      return {
        success: false,
        error: 'trading boundary write did not reach a terminal outcome',
        errorCode: 'precondition.not_ready',
        retryable: true,
        fault: false,
      };
    case 'transport_error':
      return {
        success: false,
        error: 'trading boundary is unreachable',
        errorCode: 'boundary.transport_error',
        retryable: true,
        fault: true,
      };
  }
}
