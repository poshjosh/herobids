import { describe, it, expect } from 'vitest';
import { canUseGuidedSetup } from './canUseGuidedSetup.js';
import type { UsageSummaryResponse } from '../../lib/api-client.js';

function makeSummary(overrides: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse {
  return {
    account: { id: 'acct-1', status: 'active', currency: 'USD', activePlanId: 'free' },
    currentPeriod: {
      id: 'p-1',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      includedCreditMicrousd: 0,
      usageChargeMicrousd: 0,
      creditAppliedMicrousd: 0,
      balanceMicrousd: 0,
      softCapMicrousd: null,
      hardCapMicrousd: 10000,
    },
    warnings: [],
    byMeter: {},
    ...overrides,
  };
}

describe('canUseGuidedSetup', () => {
  it('returns blocked: false when summary is null (loading state)', () => {
    expect(canUseGuidedSetup(null).blocked).toBe(false);
  });

  it('returns blocked: false when account is null (fresh user, no billing account)', () => {
    const summary = makeSummary({ account: null });
    expect(canUseGuidedSetup(summary).blocked).toBe(false);
  });

  it('returns blocked: true, reason: hard_limited when account status is hard_limited', () => {
    const summary = makeSummary({
      account: { id: 'acct-1', status: 'hard_limited', currency: 'USD', activePlanId: 'free' },
    });
    const result = canUseGuidedSetup(summary);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('hard_limited');
  });

  it('returns blocked: true, reason: suspended when account status is suspended', () => {
    const summary = makeSummary({
      account: { id: 'acct-1', status: 'suspended', currency: 'USD', activePlanId: 'free' },
    });
    const result = canUseGuidedSetup(summary);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('suspended');
  });

  it('returns blocked: false when account is active (healthy user)', () => {
    const summary = makeSummary({
      account: { id: 'acct-1', status: 'active', currency: 'USD', activePlanId: 'free' },
    });
    expect(canUseGuidedSetup(summary).blocked).toBe(false);
  });

  it('returns blocked: false when account is soft_limited (soft cap is notification-only)', () => {
    const summary = makeSummary({
      account: { id: 'acct-1', status: 'soft_limited', currency: 'USD', activePlanId: 'free' },
    });
    expect(canUseGuidedSetup(summary).blocked).toBe(false);
  });
});
