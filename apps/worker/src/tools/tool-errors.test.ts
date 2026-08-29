import { describe, expect, it } from 'vitest';

import type { CapabilityDenial } from '../agents/capability-policy.js';
import { capabilityDeniedResult, parseBrokerDenialReply } from './tool-errors.js';

describe('capabilityDeniedResult', () => {
  // ── Structural invariants ────────────────────────────────

  it('always returns success: false', () => {
    const result = capabilityDeniedResult('any_tool', {
      reason: 'capability_disabled',
      message: 'Disabled.',
    });
    expect(result.success).toBe(false);
  });

  it('always sets fault to false (content-level, not infrastructure)', () => {
    const result = capabilityDeniedResult('any_tool', {
      reason: 'rate_limit_exceeded',
      message: 'Too fast.',
      retryAfterMs: 1000,
    });
    expect(result.fault).toBe(false);
  });

  it('always sets errorCode to capability.policy_denied', () => {
    const result = capabilityDeniedResult('execute_code', {
      reason: 'capability_never_allowed',
      message: 'Nope.',
    });
    expect(result.errorCode).toBe('capability.policy_denied');
  });

  it('copies denial.message into error', () => {
    const msg = 'Rate limited: search_web used 5/5 times this minute. Try again in 30s.';
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: msg,
      retryAfterMs: 30_000,
      limit: 5,
      used: 5,
    });
    expect(result.error).toBe(msg);
  });

  // ── Transient denials (retryable: true) ──────────────────

  it('marks rate_limit_exceeded with retryAfterMs as retryable', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Rate limited.',
      retryAfterMs: 30_000,
      limit: 5,
      used: 5,
    });
    expect(result.retryable).toBe(true);
  });

  it('marks max_concurrent_exceeded as retryable even without retryAfterMs', () => {
    const result = capabilityDeniedResult('browse_url', {
      reason: 'max_concurrent_exceeded',
      message: 'Too many concurrent requests.',
      limit: 3,
      used: 3,
    });
    expect(result.retryable).toBe(true);
  });

  it('marks rate_limit_exceeded with retryAfterMs=0 as retryable', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Retry immediately.',
      retryAfterMs: 0,
    });
    expect(result.retryable).toBe(true);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBe(0);
  });

  it('includes retryAfterMs in data for transient denials', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Rate limited.',
      retryAfterMs: 15_000,
      limit: 10,
      used: 10,
    });
    const data = result.data as Record<string, unknown>;
    expect(data.retryAfterMs).toBe(15_000);
  });

  // ── Permanent denials (retryable: false) ─────────────────

  it('marks capability_disabled (no retryAfterMs) as not retryable', () => {
    const result = capabilityDeniedResult('browse_url', {
      reason: 'capability_disabled',
      message: 'Capability browse_url is disabled for this agent.',
    });
    expect(result.retryable).toBe(false);
  });

  it('marks capability_never_allowed as not retryable', () => {
    const result = capabilityDeniedResult('execute_code', {
      reason: 'capability_never_allowed',
      message: 'execute_code is never allowed.',
    });
    expect(result.retryable).toBe(false);
  });

  it('sets retryAfterMs to undefined in data for permanent denials', () => {
    const result = capabilityDeniedResult('execute_code', {
      reason: 'capability_disabled',
      message: 'Disabled.',
    });
    const data = result.data as Record<string, unknown>;
    expect(data.retryAfterMs).toBeUndefined();
  });

  // ── data pass-through ────────────────────────────────────

  it('passes reason, limit, and used through in data', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Rate limited.',
      retryAfterMs: 30_000,
      limit: 5,
      used: 5,
    });
    const data = result.data as Record<string, unknown>;
    expect(data.reason).toBe('rate_limit_exceeded');
    expect(data.limit).toBe(5);
    expect(data.used).toBe(5);
  });

  it('leaves limit and used undefined when not provided', () => {
    const result = capabilityDeniedResult('browse_url', {
      reason: 'capability_disabled',
      message: 'Disabled.',
    });
    const data = result.data as Record<string, unknown>;
    expect(data.reason).toBe('capability_disabled');
    expect(data.limit).toBeUndefined();
    expect(data.used).toBeUndefined();
  });

  // ── Full snapshot for transient denial ───────────────────

  it('returns the complete expected shape for a transient denial', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Rate limited: search_web used 5/5 times this minute. Try again in 30s.',
      retryAfterMs: 30_000,
      limit: 5,
      used: 5,
    });

    expect(result).toEqual({
      success: false,
      error: 'Rate limited: search_web used 5/5 times this minute. Try again in 30s.',
      errorCode: 'capability.policy_denied',
      retryable: true,
      fault: false,
      data: {
        reason: 'rate_limit_exceeded',
        retryAfterMs: 30_000,
        limit: 5,
        used: 5,
      },
    });
  });

  // ── Full snapshot for permanent denial ───────────────────

  it('returns the complete expected shape for a permanent denial', () => {
    const result = capabilityDeniedResult('execute_code', {
      reason: 'capability_disabled',
      message: 'Capability execute_code is disabled for this agent.',
    });

    expect(result).toEqual({
      success: false,
      error: 'Capability execute_code is disabled for this agent.',
      errorCode: 'capability.policy_denied',
      retryable: false,
      fault: false,
      data: {
        reason: 'capability_disabled',
        retryAfterMs: undefined,
        limit: undefined,
        used: undefined,
      },
    });
  });

  // ── Capability parameter is unused but accepted ──────────

  it('does not include the capability name anywhere in the result', () => {
    const result = capabilityDeniedResult('some_secret_tool', {
      reason: 'capability_disabled',
      message: 'Denied.',
    });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('some_secret_tool');
  });

  // ── TRANSIENT_REASONS edge cases ─────────────────────────

  it('marks rate_limit_exceeded as retryable even without retryAfterMs', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'rate_limit_exceeded',
      message: 'Rate limited.',
      limit: 10,
      used: 10,
    });
    expect(result.retryable).toBe(true);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBeUndefined();
  });

  it('marks kill_switch_active as not retryable even with retryAfterMs', () => {
    const result = capabilityDeniedResult('search_web', {
      reason: 'kill_switch_active',
      retryAfterMs: 60_000,
      message: 'Kill switch active.',
    });
    expect(result.retryable).toBe(false);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBe(60_000);
  });

  it('marks capability_disabled as not retryable even with retryAfterMs', () => {
    const result = capabilityDeniedResult('browse_url', {
      reason: 'capability_disabled',
      retryAfterMs: 5_000,
      message: 'Disabled.',
    });
    expect(result.retryable).toBe(false);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBe(5_000);
  });

  it('marks capability_never_allowed as not retryable even with retryAfterMs', () => {
    const result = capabilityDeniedResult('venue_api', {
      reason: 'capability_never_allowed',
      retryAfterMs: 10_000,
      message: 'Never allowed.',
    });
    expect(result.retryable).toBe(false);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBe(10_000);
  });

  it('marks unknown_capability as not retryable even with retryAfterMs', () => {
    const result = capabilityDeniedResult('nonexistent_tool', {
      reason: 'unknown_capability',
      retryAfterMs: 3_000,
      message: 'Unknown.',
    });
    expect(result.retryable).toBe(false);
    expect((result.data as Record<string, unknown>).retryAfterMs).toBe(3_000);
  });

  it('marks unknown_capability as not retryable without retryAfterMs', () => {
    const result = capabilityDeniedResult('nonexistent_tool', {
      reason: 'unknown_capability',
      message: 'Unknown capability: nonexistent_tool.',
    });
    expect(result.retryable).toBe(false);
  });

  it('marks kill_switch_active as not retryable without retryAfterMs', () => {
    const result = capabilityDeniedResult('execute_code', {
      reason: 'kill_switch_active',
      message: 'All tool invocations are temporarily suspended.',
    });
    expect(result.retryable).toBe(false);
  });

  // ── Exhaustive reason → retryable mapping ────────────────

  it('maps every CapabilityDenial reason to the correct retryable value', () => {
    const expectations: Array<{ reason: CapabilityDenial['reason']; retryable: boolean }> = [
      { reason: 'rate_limit_exceeded', retryable: true },
      { reason: 'max_concurrent_exceeded', retryable: true },
      { reason: 'kill_switch_active', retryable: false },
      { reason: 'unknown_capability', retryable: false },
      { reason: 'capability_disabled', retryable: false },
      { reason: 'capability_never_allowed', retryable: false },
    ];

    for (const { reason, retryable } of expectations) {
      const result = capabilityDeniedResult('test_tool', { reason, message: `denial: ${reason}` });
      expect(result.retryable, `expected ${reason} → retryable: ${retryable}`).toBe(retryable);
    }
  });

  // ── Full snapshot: max_concurrent_exceeded without retryAfterMs ──

  it('returns complete expected shape for max_concurrent_exceeded without retryAfterMs', () => {
    const result = capabilityDeniedResult('submit_decision', {
      reason: 'max_concurrent_exceeded',
      message: 'Concurrency limited: submit_decision has 1/1 concurrent calls active.',
      limit: 1,
      used: 1,
    });

    expect(result).toEqual({
      success: false,
      error: 'Concurrency limited: submit_decision has 1/1 concurrent calls active.',
      errorCode: 'capability.policy_denied',
      retryable: true,
      fault: false,
      data: {
        reason: 'max_concurrent_exceeded',
        retryAfterMs: undefined,
        limit: 1,
        used: 1,
      },
    });
  });
});


describe('parseBrokerDenialReply', () => {
  it('returns undefined for a non-rejected reply', () => {
    const raw = { result: { success: true } };
    expect(parseBrokerDenialReply(raw)).toBeUndefined();
  });

  it('returns undefined when status is an unrelated value', () => {
    const raw = { status: 'ok', data: 'something' };
    expect(parseBrokerDenialReply(raw)).toBeUndefined();
  });

  it('returns a ToolResult for a rejected reply with rate_limit code', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limit exceeded',
      retryAfterMs: 30_000,
      limit: 5,
      used: 5,
    };
    const result = parseBrokerDenialReply(raw);
    expect(result).toEqual({
      success: false,
      error: 'Rate limit exceeded',
      errorCode: 'capability_denied:rate_limit_exceeded',
      retryable: true,
      fault: false,
      data: {
        retryAfterMs: 30_000,
        limit: 5,
        used: 5,
      },
    });
  });

  it('returns retryable: true for max_concurrent code', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:max_concurrent_exceeded',
      message: 'Too many concurrent calls',
      limit: 3,
      used: 3,
    };
    const result = parseBrokerDenialReply(raw);
    expect(result).toBeDefined();
    expect(result!.retryable).toBe(true);
  });

  it('returns retryable: false for a non-transient code', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:capability_disabled',
      message: 'Disabled',
    };
    const result = parseBrokerDenialReply(raw);
    expect(result).toBeDefined();
    expect(result!.retryable).toBe(false);
  });

  it('uses fallback message when message field is absent', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:some_reason',
    };
    const result = parseBrokerDenialReply(raw);
    expect(result).toBeDefined();
    expect(result!.error).toBe('Capability denied: capability_denied:some_reason');
  });

  it('uses fallback error and errorCode when code is absent', () => {
    const raw = {
      status: 'rejected',
    };
    const result = parseBrokerDenialReply(raw);
    expect(result).toBeDefined();
    expect(result!.error).toBe('Capability denied: unknown');
    expect(result!.errorCode).toBe('capability.policy_denied');
    expect(result!.retryable).toBe(false);
  });

  it('leaves retryAfterMs/limit/used undefined when not in raw reply', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:capability_disabled',
      message: 'Disabled',
    };
    const result = parseBrokerDenialReply(raw);
    const data = result!.data as Record<string, unknown>;
    expect(data.retryAfterMs).toBeUndefined();
    expect(data.limit).toBeUndefined();
    expect(data.used).toBeUndefined();
  });

  it('always sets fault to false', () => {
    const raw = {
      status: 'rejected',
      code: 'capability_denied:rate_limit_exceeded',
      message: 'Rate limited',
    };
    expect(parseBrokerDenialReply(raw)!.fault).toBe(false);
  });
});
