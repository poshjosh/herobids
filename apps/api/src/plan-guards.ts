import type { PlanAgentsEntitlements, PlanEntitlements, PlanLimitsEntitlements, PlanSkillsEntitlements, PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { bots, venueAccounts, userCredentials, backtestRuns, agents, connections } from '@herobids/db';
import { eq, and, inArray } from 'drizzle-orm';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

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

export type PlanCheckResult = Result<void, {
  code: string;
  message: string;
  limit: number;
  current: number;
  params?: Record<string, unknown>;
}>;

function resolvePlanForCheck(config: PlansConfig, planId: string, isAdmin: boolean): ResolvedPlanEntitlements {
  return resolvePlanEntitlements(config, { planId, isAdmin });
}

/** Check if user can create a new venue account */
export async function checkVenueAccountLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  const rows = await db.select({ id: venueAccounts.id }).from(venueAccounts).where(eq(venueAccounts.userId, userId));
  if (rows.length >= limits.maxVenueAccounts) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Venue account limit reached (${limits.maxVenueAccounts})`,
      limit: limits.maxVenueAccounts,
      current: rows.length,
      params: { resource: 'venue_account', limit: limits.maxVenueAccounts, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new credential */
export async function checkCredentialLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  const rows = await db.select({ id: userCredentials.id }).from(userCredentials).where(eq(userCredentials.userId, userId));
  if (rows.length >= limits.maxCredentials) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Credential limit reached (${limits.maxCredentials})`,
      limit: limits.maxCredentials,
      current: rows.length,
      params: { resource: 'credential', limit: limits.maxCredentials, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new bot */
export async function checkBotLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  const rows = await db.select({ id: bots.id }).from(bots)
    .where(eq(bots.userId, userId));
  if (rows.length >= limits.maxBots) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Bot limit reached (${limits.maxBots})`,
      limit: limits.maxBots,
      current: rows.length,
      params: { resource: 'bot', limit: limits.maxBots, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new trading instance (alias for checkBotLimit) */
export const checkTradingInstanceLimit = checkBotLimit;

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

/** Check if user can create a new backtest run (concurrent limit) */
export async function checkBacktestLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  const rows = await db.select({ id: backtestRuns.id }).from(backtestRuns)
    .where(and(eq(backtestRuns.userId, userId), inArray(backtestRuns.status, ['pending', 'running'])));
  if (rows.length >= limits.maxConcurrentBacktests) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Concurrent backtest limit reached (${limits.maxConcurrentBacktests})`,
      limit: limits.maxConcurrentBacktests,
      current: rows.length,
      params: { resource: 'backtest', limit: limits.maxConcurrentBacktests, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new agent */
export async function checkAgentLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId));
  if (rows.length >= limits.maxAgents) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Agent limit reached (${limits.maxAgents})`,
      limit: limits.maxAgents,
      current: rows.length,
      params: { resource: 'agent', limit: limits.maxAgents, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new connection */
export async function checkConnectionLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;

  const rows = await db.select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.status, 'active')));

  if (rows.length >= limits.maxConnections) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Connection limit reached (${limits.maxConnections})`,
      limit: limits.maxConnections,
      current: rows.length,
      params: { resource: 'connection', limit: limits.maxConnections, current: rows.length },
    });
  }

  return ok(undefined);
}

/** Check if user can create a new trading connection (replaces binding limit check) */
export async function checkBindingLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;

  const rows = await db.select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.status, 'active')));

  if (rows.length >= limits.maxBindings) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Connection limit reached (${limits.maxBindings})`,
      limit: limits.maxBindings,
      current: rows.length,
      params: { resource: 'connection', limit: limits.maxBindings, current: rows.length },
    });
  }

  return ok(undefined);
}
