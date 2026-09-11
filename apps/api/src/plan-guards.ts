import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { venueAccounts, userCredentials, agents, connections } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
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
