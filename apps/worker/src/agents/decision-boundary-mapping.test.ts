import { describe, it, expect } from 'vitest';
import {
  buildSubmitDecisionPayload,
  mapBoundaryResultToDecisionOutcome,
} from './decision-boundary-mapping.js';
import type { DecisionSubmitPayload } from '@herobids/domain';

const BASE_PAYLOAD: DecisionSubmitPayload = {
  instrumentId: 'INSTR-1',
  intent: 'buy',
  targetSize: '1.5',
  rationaleSummary: 'test',
};

describe('decision-boundary-mapping — profile-era payloads', () => {
  it('sends only the platform-selected venue account with a decision', () => {
    const out = buildSubmitDecisionPayload(BASE_PAYLOAD, 'va-1');
    expect(out).toEqual({ ...BASE_PAYLOAD, venueAccountId: 'va-1' });
  });

  it('does not echo capital, risk, or execution mode into a decision', () => {
    const out = buildSubmitDecisionPayload(BASE_PAYLOAD, 'va-1');
    expect(out).not.toHaveProperty('capital');
    expect(out).not.toHaveProperty('riskPosture');
    expect(out).not.toHaveProperty('riskOverrides');
    expect(out).not.toHaveProperty('executionMode');
  });

});

describe('decision-boundary-mapping — unknown outcomes', () => {
  it('maps a transport error to an unknown-outcome error rather than claiming the decision was not submitted', () => {
    const outcome = mapBoundaryResultToDecisionOutcome({
      kind: 'transport_error',
      requestId: 'req-1',
      retryable: true,
      message: 'request to boundary failed',
    });

    expect(outcome).toMatchObject({ status: 'error', code: 'boundary.transport_error', retryable: true });
    expect(outcome.message).toMatch(/outcome of this decision is unknown/);
    expect(outcome.message).not.toMatch(/not submitted/);
    expect(outcome.message).toMatch(/did not return a response/);
  });

  it('maps a write still running at the deadline to an unknown-outcome error, not a rejection', () => {
    const outcome = mapBoundaryResultToDecisionOutcome({ kind: 'in_progress', requestId: 'req-1', correlationId: 'corr-1' });

    expect(outcome).toMatchObject({ status: 'error', code: 'boundary.in_progress', retryable: true });
    expect(outcome.message).toMatch(/outcome of this decision is unknown/);
  });
});