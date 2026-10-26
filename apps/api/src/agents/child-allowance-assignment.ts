import {
  AGENT_CHILDREN_MANAGEMENT_SKILL_ID,
  resolveChildAgentLimitCeiling,
  resolvePlanLimitEntitlements,
  type PlansConfig,
} from '@herobids/domain';

export const CHILD_ALLOWANCE_NO_PLAN_NOTICE = 'Your plan does not include child agents, so the child agent limit stays at 0.';

export interface ChildAllowanceAssignmentInput {
  plansConfig: PlansConfig | undefined;
  planId: string;
  isAdmin: boolean;
  /** Skill ids the agent holds before this write. Empty for a create. */
  previousSkillIds: readonly string[];
  /** Skill ids the agent holds after this write. */
  nextSkillIds: readonly string[];
}

export interface ChildAllowanceAssignment {
  /** The limit to write in the same transaction as the skill assignment. */
  childAgentLimit: number;
  /** Set when the limit stayed at 0 because the plan allows no children. */
  notice?: string;
}

/**
 * The child-allowance write for a user's assignment of the children skill. Returns null unless this
 * write newly adds the skill, so a later save that keeps it leaves the limit alone. Without a plan
 * config there is no ceiling to grant against, so the limit fails closed at 0.
 */
export function childAllowanceForNewAssignment(input: ChildAllowanceAssignmentInput): ChildAllowanceAssignment | null {
  const skillId = AGENT_CHILDREN_MANAGEMENT_SKILL_ID;
  if (!input.nextSkillIds.includes(skillId) || input.previousSkillIds.includes(skillId)) return null;

  const ceiling = input.plansConfig
    ? resolveChildAgentLimitCeiling(resolvePlanLimitEntitlements(input.plansConfig, input.planId, input.isAdmin))
    : 0;
  return ceiling > 0
    ? { childAgentLimit: ceiling }
    : { childAgentLimit: 0, notice: CHILD_ALLOWANCE_NO_PLAN_NOTICE };
}
