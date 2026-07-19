import { describe, it, expect } from 'vitest';
import {
  resolveSettlement,
  validateSettlementPolicy,
  type AssessmentSettlementOutcome,
} from './assessment-settlement-policy.js';

describe('AssessmentSettlementPolicy', () => {
  it('validates the policy is exhaustive', () => {
    expect(validateSettlementPolicy()).toBe(true);
  });

  describe('non-billable outcomes', () => {
    const nonBillable: AssessmentSettlementOutcome[] = [
      'request_in_flight',
      'identity_unresolved',
      'cooldown_blocked',
      'billing_blocked',
    ];

    for (const outcome of nonBillable) {
      it(`${outcome}: shouldReserve=false, shouldCapture=false, shouldRelease=false, countsTowardDailyCap=false`, () => {
        const result = resolveSettlement(outcome);
        expect(result.shouldReserve).toBe(false);
        expect(result.shouldCapture).toBe(false);
        expect(result.shouldRelease).toBe(false);
        expect(result.countsTowardDailyCap).toBe(false);
        expect(result.billingOutcome).toBe('none');
      });
    }
  });

  describe('billable success outcomes', () => {
    const billable: AssessmentSettlementOutcome[] = ['cache_hit', 'assessment_completed'];

    for (const outcome of billable) {
      it(`${outcome}: shouldReserve=true, shouldCapture=true, shouldRelease=false, countsTowardDailyCap=true`, () => {
        const result = resolveSettlement(outcome);
        expect(result.shouldReserve).toBe(true);
        expect(result.shouldCapture).toBe(true);
        expect(result.shouldRelease).toBe(false);
        expect(result.countsTowardDailyCap).toBe(true);
        expect(result.billingOutcome).toBe('captured');
      });
    }
  });

  describe('provider_failed', () => {
    it('shouldReserve=true, shouldCapture=false, shouldRelease=true, countsTowardDailyCap=true', () => {
      const result = resolveSettlement('provider_failed');
      expect(result.shouldReserve).toBe(true);
      expect(result.shouldCapture).toBe(false);
      expect(result.shouldRelease).toBe(true);
      expect(result.countsTowardDailyCap).toBe(true);
      expect(result.billingOutcome).toBe('released');
    });
  });
});
