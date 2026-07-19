export type AssessmentSettlementOutcome =
  | 'request_in_flight'
  | 'identity_unresolved'
  | 'cooldown_blocked'
  | 'billing_blocked'
  | 'cache_hit'
  | 'assessment_completed'
  | 'provider_failed';

export interface AssessmentSettlementResult {
  shouldReserve: boolean;
  shouldCapture: boolean;
  shouldRelease: boolean;
  countsTowardDailyCap: boolean;
  billingOutcome: 'reserved' | 'captured' | 'released' | 'none';
}

export const SETTLEMENT_POLICY: Record<AssessmentSettlementOutcome, AssessmentSettlementResult> = {
  request_in_flight: {
    shouldReserve: false,
    shouldCapture: false,
    shouldRelease: false,
    countsTowardDailyCap: false,
    billingOutcome: 'none',
  },
  identity_unresolved: {
    shouldReserve: false,
    shouldCapture: false,
    shouldRelease: false,
    countsTowardDailyCap: false,
    billingOutcome: 'none',
  },
  cooldown_blocked: {
    shouldReserve: false,
    shouldCapture: false,
    shouldRelease: false,
    countsTowardDailyCap: false,
    billingOutcome: 'none',
  },
  billing_blocked: {
    shouldReserve: false,
    shouldCapture: false,
    shouldRelease: false,
    countsTowardDailyCap: false,
    billingOutcome: 'none',
  },
  cache_hit: {
    shouldReserve: true,
    shouldCapture: true,
    shouldRelease: false,
    countsTowardDailyCap: true,
    billingOutcome: 'captured',
  },
  assessment_completed: {
    shouldReserve: true,
    shouldCapture: true,
    shouldRelease: false,
    countsTowardDailyCap: true,
    billingOutcome: 'captured',
  },
  provider_failed: {
    shouldReserve: true,
    shouldCapture: false,
    shouldRelease: true,
    countsTowardDailyCap: true,
    billingOutcome: 'released',
  },
};

export function resolveSettlement(outcome: AssessmentSettlementOutcome): AssessmentSettlementResult {
  return SETTLEMENT_POLICY[outcome];
}

export function validateSettlementPolicy(): boolean {
  const expectedOutcomes: AssessmentSettlementOutcome[] = [
    'request_in_flight',
    'identity_unresolved',
    'cooldown_blocked',
    'billing_blocked',
    'cache_hit',
    'assessment_completed',
    'provider_failed',
  ];
  return expectedOutcomes.every((o) => SETTLEMENT_POLICY[o] !== undefined);
}
