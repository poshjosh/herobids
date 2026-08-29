import type { PlanAgentsEntitlements, PlanBlueprintsEntitlements, PlanEntitlements, PlanLimitsEntitlements, PlanSkillsEntitlements, PlansConfig } from './config/index.js';
import type { Result } from './result.js';
import { ok, err } from './result.js';

export interface ResolvedPlanEntitlements {
  planId: string;
  isAdminBypass: boolean;
  entitlements: PlanEntitlements;
}

const ABSOLUTE_FALLBACK_ENTITLEMENTS: PlanEntitlements = {
  skills: {
    canCreatePrivateSkills: true,
    canViewMarketplaceSkills: false,
    canPublishToMarketplace: false,
    autoPublishNonDraftSkills: false,
    canPriceSkills: false,
    canLikeMarketplaceSkills: true,
  },
  agents: {
    canViewOwnPrompts: true,
  },
  blueprints: {
    canViewMarketplaceBlueprints: false,
    canLikeMarketplaceBlueprints: false,
  },
  limits: {
    maxAgents: 0,
    maxBots: 1,
    maxConnections: 1,
    maxCredentials: 1,
    maxBindings: 1,
    maxVenueAccounts: 1,
    maxConcurrentBacktests: 1,
    liveEnabled: false,
  },
};

function resolvePlanDefinition(config: PlansConfig, requestedPlanId: string) {
  const fallback = config.plans[config.defaultPlanId];
  const resolved = config.plans[requestedPlanId] ?? fallback;
  return {
    resolvedPlanId: config.plans[requestedPlanId] ? requestedPlanId : config.defaultPlanId,
    plan: resolved,
  };
}

export function resolvePlanEntitlements(
  config: PlansConfig,
  context: { planId: string; isAdmin: boolean },
): ResolvedPlanEntitlements {
  const { resolvedPlanId, plan } = resolvePlanDefinition(config, context.planId);
  if (!plan) {
    return {
      planId: context.planId || 'free',
      isAdminBypass: context.isAdmin,
      entitlements: ABSOLUTE_FALLBACK_ENTITLEMENTS,
    };
  }

  if (context.isAdmin) {
    return {
      planId: resolvedPlanId,
      isAdminBypass: true,
      entitlements: {
        skills: {
          canCreatePrivateSkills: true,
          canViewMarketplaceSkills: true,
          canPublishToMarketplace: true,
          autoPublishNonDraftSkills: false,
          canPriceSkills: true,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: true,
          canLikeMarketplaceBlueprints: true,
        },
        limits: {
          ...plan.entitlements.limits,
          liveEnabled: true,
        },
      },
    };
  }

  return {
    planId: resolvedPlanId,
    isAdminBypass: false,
    entitlements: plan.entitlements,
  };
}

export function resolvePlanSkillEntitlements(config: PlansConfig, planId: string, isAdmin = false): PlanSkillsEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin }).entitlements.skills;
}

export function resolvePlanAgentEntitlements(config: PlansConfig, planId: string, isAdmin = false): PlanAgentsEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin }).entitlements.agents;
}

export function resolvePlanLimitEntitlements(config: PlansConfig, planId: string, isAdmin = false): PlanLimitsEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin }).entitlements.limits;
}

export function resolvePlanBlueprintEntitlements(config: PlansConfig, planId: string, isAdmin = false): PlanBlueprintsEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin }).entitlements.blueprints;
}

export type PlanCheckResult = Result<void, {
  code: string;
  message: string;
  limit: number;
  current: number;
  params?: Record<string, unknown>;
}>;

export function resolvePlanForCheck(config: PlansConfig, planId: string, isAdmin: boolean): ResolvedPlanEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin });
}

/** Check if user's plan allows live execution */
export function checkLiveEnabled(config: PlansConfig, planId: string, isAdmin: boolean = false): PlanCheckResult {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  if (!limits.liveEnabled) {
    return err({
      code: 'plan.live_disabled',
      message: 'Live trading is not available on your current plan',
      limit: 0,
      current: 0,
      params: { resource: 'live_trading' },
    });
  }
  return ok(undefined);
}
