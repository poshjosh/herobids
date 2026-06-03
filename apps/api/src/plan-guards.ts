import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { tradingInstances, venueAccounts, credentials, portfolios, backtestRuns, agents } from '@herobids/db';
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

export type PlanCheckResult = Result<void, { code: string; message: string; limit: number; current: number }>;

/** Check if user can create a new portfolio */
export async function checkPortfolioLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: portfolios.id }).from(portfolios).where(eq(portfolios.userId, userId));
  if (rows.length >= limits.maxPortfolios) {
    return err({ code: 'plan.limit_exceeded', message: `Portfolio limit reached (${limits.maxPortfolios})`, limit: limits.maxPortfolios, current: rows.length });
  }
  return ok(undefined);
}

/** Check if user can create a new venue account */
export async function checkVenueAccountLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: venueAccounts.id }).from(venueAccounts).where(eq(venueAccounts.userId, userId));
  if (rows.length >= limits.maxVenueAccounts) {
    return err({ code: 'plan.limit_exceeded', message: `Venue account limit reached (${limits.maxVenueAccounts})`, limit: limits.maxVenueAccounts, current: rows.length });
  }
  return ok(undefined);
}

/** Check if user can create a new credential */
export async function checkCredentialLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: credentials.id }).from(credentials).where(eq(credentials.userId, userId));
  if (rows.length >= limits.maxCredentials) {
    return err({ code: 'plan.limit_exceeded', message: `Credential limit reached (${limits.maxCredentials})`, limit: limits.maxCredentials, current: rows.length });
  }
  return ok(undefined);
}

/** Check if user can create a new trading instance */
export async function checkTradingInstanceLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  // Count all instances (including stopped) — maxTradingInstances is a total-instance cap,
  // not a concurrent cap, to prevent unbounded accumulation of stopped instances.
  const rows = await db.select({ id: tradingInstances.id }).from(tradingInstances)
    .where(eq(tradingInstances.userId, userId));
  if (rows.length >= limits.maxTradingInstances) {
    return err({ code: 'plan.limit_exceeded', message: `Trading instance limit reached (${limits.maxTradingInstances})`, limit: limits.maxTradingInstances, current: rows.length });
  }
  return ok(undefined);
}

/** Check if user's plan allows live execution */
export function checkLiveEnabled(config: PlansConfig, planId: string): PlanCheckResult {
  const limits = resolvePlanLimits(config, planId);
  if (!limits.liveEnabled) {
    return err({ code: 'plan.live_disabled', message: 'Live trading is not available on your current plan', limit: 0, current: 0 });
  }
  return ok(undefined);
}

/** Check if user can create a new backtest run (concurrent limit) */
export async function checkBacktestLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: backtestRuns.id }).from(backtestRuns)
    .where(and(eq(backtestRuns.userId, userId), inArray(backtestRuns.status, ['pending', 'running'])));
  if (rows.length >= limits.maxConcurrentBacktests) {
    return err({ code: 'plan.limit_exceeded', message: `Concurrent backtest limit reached (${limits.maxConcurrentBacktests})`, limit: limits.maxConcurrentBacktests, current: rows.length });
  }
  return ok(undefined);
}

/** Check if user can create a new agent */
export async function checkAgentLimit(db: Database, config: PlansConfig, userId: string, planId: string): Promise<PlanCheckResult> {
  const limits = resolvePlanLimits(config, planId);
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId));
  if (rows.length >= limits.maxAgents) {
    return err({ code: 'plan.limit_exceeded', message: `Agent limit reached (${limits.maxAgents})`, limit: limits.maxAgents, current: rows.length });
  }
  return ok(undefined);
}
