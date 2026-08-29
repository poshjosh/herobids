import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { bots, venueAccounts, userCredentials, backtestRuns, agents, connections } from '@herobids/db';
import { eq, and, inArray } from 'drizzle-orm';
import { ok, err } from '@herobids/domain';

export {
  type ResolvedPlanEntitlements,
  type PlanCheckResult,
  resolvePlanEntitlements,
  resolvePlanSkillEntitlements,
  resolvePlanAgentEntitlements,
  resolvePlanLimitEntitlements,
  resolvePlanBlueprintEntitlements,
  resolvePlanForCheck,
  checkLiveEnabled,
} from '@herobids/domain';

import { resolvePlanForCheck, type PlanCheckResult } from '@herobids/domain';

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
