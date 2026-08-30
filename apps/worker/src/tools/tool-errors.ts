import type { ToolResult } from '@herobids/domain';

import type { CapabilityDenial } from '../agents/capability-policy.js';

/** Build a non-fault ToolResult for content-level errors. */
export function nonFaultError(error: string, retryable = false): ToolResult {
  return { success: false, error, retryable, fault: false };
}

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


/**
 * Parse a broker denial reply. Returns a ToolResult if the raw reply is a
 * capability denial (`status: 'rejected'`), or undefined if it's a normal reply.
 * Used by brokered tools (assess_strategy_preset, change_strategy_preset,
 * manage_agent_skills) to handle denials from the broker's capability policy gate.
 */
export function parseBrokerDenialReply(raw: Record<string, unknown>): ToolResult | undefined {
  if (raw.status !== 'rejected') return undefined;

  const code = raw.code as string | undefined;
  const isTransient = code !== undefined
    && (code.includes('rate_limit') || code.includes('max_concurrent'));

  return {
    success: false,
    error: (raw.message as string) ?? `Capability denied: ${code ?? 'unknown'}`,
    errorCode: code ?? 'capability.policy_denied',
    retryable: isTransient,
    fault: false,
    data: {
      retryAfterMs: raw.retryAfterMs as number | undefined,
      limit: raw.limit as number | undefined,
      used: raw.used as number | undefined,
    },
  };
}
