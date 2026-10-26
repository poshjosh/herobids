import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import type { AgentLifecycleError } from '../services/agent-lifecycle-service.js';
import { startCreatedChild } from './child-start.js';

const STARTED = ok({ status: 'starting', sessionId: 'session-1' });

describe('startCreatedChild', () => {
  it('starts the child and reports it started with no error', async () => {
    const start = vi.fn(async () => STARTED);

    const outcome = await startCreatedChild(start, true);

    expect(start).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ started: true, startError: null });
  });

  it('does not start the child when the start is not requested', async () => {
    const start = vi.fn(async () => STARTED);

    const outcome = await startCreatedChild(start, false);

    expect(start).not.toHaveBeenCalled();
    expect(outcome).toEqual({ started: false, startError: null });
  });

  it('reports a refused start with its namespaced code and message', async () => {
    const refusal: AgentLifecycleError = {
      code: 'agent.model_selection_incomplete',
      message: 'Agent cannot start — set provider, lightModel, and heavyModel in agent config or user AI settings',
    };

    const outcome = await startCreatedChild(async () => err(refusal), true);

    expect(outcome).toEqual({
      started: false,
      startError: { code: 'agent.model_selection_incomplete', message: refusal.message },
    });
  });

  it('reports a skill portability refusal with its code', async () => {
    const outcome = await startCreatedChild(
      async () => err({ code: 'agent.skill_portability', message: 'Skill cannot be ported' }),
      true,
    );

    expect(outcome).toEqual({
      started: false,
      startError: { code: 'agent.skill_portability', message: 'Skill cannot be ported' },
    });
  });

  it('keeps an internal cause out of the message the agent sees', async () => {
    const outcome = await startCreatedChild(
      async () => err({ code: 'agent.internal_error', message: 'connect ECONNREFUSED 10.0.0.5:5432' }),
      true,
    );

    expect(outcome.started).toBe(false);
    expect(outcome.startError?.code).toBe('agent.internal_error');
    expect(outcome.startError?.message).not.toContain('10.0.0.5');
    expect(outcome.startError?.message).toContain('ask the user to start it');
  });
});
