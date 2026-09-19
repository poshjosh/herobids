import { describe, it, expect } from 'vitest';
import {
  buildSubmitDecisionPayload,
  buildRiskSpecPayloadFields,
  type AgentRiskInjection,
} from './decision-boundary-mapping.js';
import type { DecisionSubmitPayload } from '@herobids/domain';

const BASE_PAYLOAD: DecisionSubmitPayload = {
  instrumentId: 'INSTR-1',
  intent: 'buy',
  targetSize: '1.5',
  rationaleSummary: 'test',
};

describe('decision-boundary-mapping — Option A executionMode injection', () => {
  it('stamps executionMode onto the submit_decision payload when injected', () => {
    const risk: AgentRiskInjection = { capital: '1000', executionMode: 'shadow' };
    const out = buildSubmitDecisionPayload(BASE_PAYLOAD, 'va-1', risk);
    expect(out.executionMode).toBe('shadow');
  });

  it('omits executionMode when null (operator default applies)', () => {
    const risk: AgentRiskInjection = { capital: '1000', executionMode: null };
    const out = buildSubmitDecisionPayload(BASE_PAYLOAD, 'va-1', risk);
    expect(out.executionMode).toBeUndefined();
  });

  it('omits executionMode when absent (back-compat)', () => {
    const risk: AgentRiskInjection = { capital: '1000' };
    const out = buildSubmitDecisionPayload(BASE_PAYLOAD, 'va-1', risk);
    expect(out.executionMode).toBeUndefined();
  });

  it('stamps executionMode onto the risk-spec read payload when injected', () => {
    const risk: AgentRiskInjection = { capital: '1000', executionMode: 'live' };
    const out = buildRiskSpecPayloadFields(risk);
    expect(out.executionMode).toBe('live');
    expect(out.capital).toBe('1000');
  });

  it('omits executionMode from the risk-spec read payload when absent', () => {
    const out = buildRiskSpecPayloadFields({ capital: '1000' });
    expect(out.executionMode).toBeUndefined();
  });
});