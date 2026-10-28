import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePlanLimitEntitlements, type PlanLimitsEntitlements, type PlansConfig } from '@herobids/domain';
import { childAllowanceForNewAssignment, CHILD_ALLOWANCE_NO_PLAN_NOTICE } from './child-allowance-assignment.js';

vi.mock('@herobids/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/domain')>();
  return { ...actual, resolvePlanLimitEntitlements: vi.fn() };
});

const PLANS_CONFIG = {} as PlansConfig;
const CHILDREN = 'child-agent-management';

function limitsWith(limits: { maxAgents: number; childAgentLimitCeiling?: number }): PlanLimitsEntitlements {
  return limits as PlanLimitsEntitlements;
}

function input(overrides: Partial<Parameters<typeof childAllowanceForNewAssignment>[0]> = {}) {
  return {
    plansConfig: PLANS_CONFIG,
    planId: 'pro',
    isAdmin: false,
    previousSkillIds: [] as string[],
    nextSkillIds: [CHILDREN],
    ...overrides,
  };
}

describe('childAllowanceForNewAssignment', () => {
  beforeEach(() => {
    vi.mocked(resolvePlanLimitEntitlements).mockReset();
  });

  it('sets the limit to the plan ceiling when the children skill is newly assigned', () => {
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue(limitsWith({ maxAgents: 5, childAgentLimitCeiling: 3 }));

    expect(childAllowanceForNewAssignment(input())).toEqual({ childAgentLimit: 3 });
    expect(resolvePlanLimitEntitlements).toHaveBeenCalledWith(PLANS_CONFIG, 'pro', false);
  });

  it('uses maxAgents minus one when the plan sets no explicit ceiling', () => {
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue(limitsWith({ maxAgents: 4 }));

    expect(childAllowanceForNewAssignment(input())).toEqual({ childAgentLimit: 3 });
  });

  it('keeps the limit at 0 with a notice when the plan allows no children', () => {
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue(limitsWith({ maxAgents: 1 }));

    expect(childAllowanceForNewAssignment(input())).toEqual({ childAgentLimit: 0, notice: CHILD_ALLOWANCE_NO_PLAN_NOTICE });
  });

  it('fails closed at 0 with a notice when there is no plan configuration', () => {
    expect(childAllowanceForNewAssignment(input({ plansConfig: undefined }))).toEqual({
      childAgentLimit: 0,
      notice: CHILD_ALLOWANCE_NO_PLAN_NOTICE,
    });
    expect(resolvePlanLimitEntitlements).not.toHaveBeenCalled();
  });

  it('passes the admin flag to the plan entitlements', () => {
    vi.mocked(resolvePlanLimitEntitlements).mockReturnValue(limitsWith({ maxAgents: 2, childAgentLimitCeiling: 1 }));

    childAllowanceForNewAssignment(input({ isAdmin: true }));

    expect(resolvePlanLimitEntitlements).toHaveBeenCalledWith(PLANS_CONFIG, 'pro', true);
  });

  it('returns null when the skill is already held, so a later save leaves the limit alone', () => {
    expect(childAllowanceForNewAssignment(input({ previousSkillIds: [CHILDREN], nextSkillIds: [CHILDREN, 'browser'] }))).toBeNull();
    expect(resolvePlanLimitEntitlements).not.toHaveBeenCalled();
  });

  it('returns null when the write does not include the children skill', () => {
    expect(childAllowanceForNewAssignment(input({ nextSkillIds: ['browser'] }))).toBeNull();
  });
});
