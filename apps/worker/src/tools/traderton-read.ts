// Shared mapping from a Traderton boundary read result to a tool `ToolResult`
// (L3b §3c). All five rewired read tools use this so the mapping stays DRY and
// consistent: success carries the boundary payload through unchanged; typed
// failures preserve code/retryable and derive fault from whether the failure is
// content-level (validation/not-found) or infrastructure; in_progress and
// transport_error become typed retryable failures rather than raw throws.

import type { ToolResult, TradertonReadResult } from '@herobids/domain';

/**
 * Boundary failure codes that are content-level outcomes (the request was
 * understood; the answer is "invalid" or "absent"). These do NOT count against
 * the tool's circuit breaker, so `fault:false`. Every other failure code is an
 * infrastructure/internal fault (`fault:true`).
 */
const CONTENT_LEVEL_FAILURE_CODES = new Set<string>([
  'validation.invalid_payload',
  'not_found.resource',
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
