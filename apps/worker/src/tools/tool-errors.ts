import type { ToolResult } from '@herobids/domain';

import type { CapabilityDenial } from '../agents/capability-policy.js';

/** Reasons that represent transient conditions the caller can retry. */
const TRANSIENT_REASONS = new Set<CapabilityDenial['reason']>(['rate_limit_exceeded', 'max_concurrent_exceeded']);

/**
 * Build a consistent ToolResult for a capability policy denial.
 * Transient denials (rate limit, concurrency) are marked retryable.
 */
export function capabilityDeniedResult(_capability: string, denial: CapabilityDenial): ToolResult {
  return {
    success: false,
    error: denial.message,
    errorCode: 'capability.policy_denied',
    retryable: TRANSIENT_REASONS.has(denial.reason),
    fault: false,
    data: {
      reason: denial.reason,
      retryAfterMs: denial.retryAfterMs,
      limit: denial.limit,
      used: denial.used,
    },
  };
}
