import { describe, it, expect, vi } from 'vitest';
import {
  CREATE_AGENT_OUTCOMES,
  createAgentOutcomeForRule,
  recordCreateAgentAttempt,
  takeCreateAgentOutcome,
  setCreateAgentOutcome,
} from './agent-create-metrics.js';

describe('create_agent attempt metrics', () => {
  it('records each outcome in the closed set as one agent.create_attempt line', () => {
    const info = vi.fn();
    for (const outcome of CREATE_AGENT_OUTCOMES) {
      expect(recordCreateAgentAttempt({ info }, outcome)).toBe(true);
    }

    expect(info).toHaveBeenCalledTimes(CREATE_AGENT_OUTCOMES.length);
    expect(info).toHaveBeenCalledWith({ evt: 'agent.create_attempt', outcome: 'limiter_unavailable' }, 'create_agent attempt');
  });

  it('does not record an outcome outside the closed set', () => {
    const info = vi.fn();

    expect(recordCreateAgentAttempt({ info }, 'agent_7f3c9')).toBe(false);
    expect(recordCreateAgentAttempt({ info }, 'Success')).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('maps every policy refusal rule onto a bounded outcome', () => {
    expect(createAgentOutcomeForRule('rate')).toBe('rate');
    expect(createAgentOutcomeForRule('limiter')).toBe('limiter_unavailable');
    expect(createAgentOutcomeForRule('allowance')).toBe('allowance');
    expect(createAgentOutcomeForRule('depth')).toBe('depth');
    expect(createAgentOutcomeForRule('plan_total')).toBe('plan_total');
    expect(createAgentOutcomeForRule('grant')).toBe('grant_refused');
    expect(createAgentOutcomeForRule('ownership')).toBe('other');
    expect(createAgentOutcomeForRule('permission')).toBe('other');
  });

  it('reports other when no outcome was set for a request', () => {
    const request = {};

    expect(takeCreateAgentOutcome(request)).toBe('other');
    setCreateAgentOutcome(request, 'depth');
    expect(takeCreateAgentOutcome(request)).toBe('depth');
  });
});
