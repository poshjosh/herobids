import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { bots, venueAccounts, userCredentials, backtestRuns, agents } from '@herobids/db';
import { eq, and, inArray } from 'drizzle-orm';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

interface PlanLimits {
  maxPortfolios: number;
  maxVenueAccounts: number;
  maxCredentials: number;
  maxTradingInstances: number;
  maxConcurrentBacktests: number;
  maxAgents: number;
  liveEnabled: boolean;
}

/** Resolve plan limits for a given planId. Falls back to default plan if unknown. */
function resolvePlanLimits(config: PlansConfig, planId: string): PlanLimits {
  const plan = config.plans[planId] ?? config.plans[config.defaultPlanId];
  if (!plan) {
    // Absolute fallback — should never happen if config is valid
    return { maxPortfolios: 1, maxVenueAccounts: 1, maxCredentials: 1, maxTradingInstances: 1, maxConcurrentBacktests: 1, maxAgents: 0, liveEnabled: false };
  }
  return plan;
}

export type PlanCheckResult = Result<void, {
  code: string;
  message: string;
  limit: number;
  current: number;
  params?: Record<string, unknown>;
}>;

/** Check if user can create a new venue account */
export async function checkVenueAccountLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
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
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
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
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: bots.id }).from(bots)
    .where(eq(bots.userId, userId));
  if (rows.length >= limits.maxTradingInstances) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Bot limit reached (${limits.maxTradingInstances})`,
      limit: limits.maxTradingInstances,
      current: rows.length,
      params: { resource: 'bot', limit: limits.maxTradingInstances, current: rows.length },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new trading instance (alias for checkBotLimit) */
export const checkTradingInstanceLimit = checkBotLimit;

/** Check if user's plan allows live execution */
export function checkLiveEnabled(config: PlansConfig, planId: string, isAdmin: boolean = false): PlanCheckResult {
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
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
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
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
  if (isAdmin) return ok(undefined);
  const limits = resolvePlanLimits(config, planId);
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
