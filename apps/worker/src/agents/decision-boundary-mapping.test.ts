import { describe, it, expect } from 'vitest';
import {
  buildSubmitDecisionPayload,
  buildRiskSpecPayloadFields,
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

  it('sends the selected venue account for profile-owned risk reads', () => {
    expect(buildRiskSpecPayloadFields('va-1')).toEqual({ venueAccountId: 'va-1' });
  });

  it('sends no agents-row enforcement fields for an unresolved account', () => {
    expect(buildRiskSpecPayloadFields()).toEqual({});
  });
});