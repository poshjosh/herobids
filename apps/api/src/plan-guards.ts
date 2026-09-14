import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { platformCredentials, agents, connections } from '@herobids/db';
import type { TradertonClient } from '@herobids/domain/traderton';
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

/**
 * Check if user can create a new venue account.
 *
 * Venue accounts are owned by Traderton (behind the boundary) after L3-P1b, so
 * the count is sourced from the boundary's `count_venue_accounts` read tool
 * rather than a local table — herobids still ENFORCES its own plan limit, but
 * reads the true count from the system of record. This MUST NOT run inside a DB
 * transaction (it makes a boundary HTTP call).
 *
 * Fails closed: when the boundary is unavailable (no client, transport error,
 * in-progress, failure, or a malformed payload) the check returns a
 * `precondition.not_ready` error rather than silently allowing — a venue
 * account cannot be provisioned without the boundary anyway.
 */
export async function checkVenueAccountLimit(
  tradertonClient: TradertonClient | undefined,
  config: PlansConfig,
  userId: string,
  planId: string,
  isAdmin: boolean,
): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;

  // A fail-closed precondition error. `limit`/`current` are required by
  // PlanCheckResult but inert here (the check never reached a count); consumers
  // branch on `code` and surface it as a 503.
  const unavailable = () =>
    err({
      code: 'precondition.not_ready',
      message: 'Trading service is unavailable — cannot verify the venue-account limit.',
      limit: limits.maxVenueAccounts,
      current: 0,
      params: { resource: 'venue_account' },
    });

  if (!tradertonClient) return unavailable();

  const result = await tradertonClient.invoke({
    toolName: 'count_venue_accounts',
    payload: {},
    subject: { ownerId: userId, actor: { type: 'user', id: userId } },
    deadlineMs: 30_000,
  });

  if (result.kind !== 'success') return unavailable();

  const payload = result.payload as { count?: unknown } | null;
  if (typeof payload?.count !== 'number') return unavailable();
  const count = payload.count;

  if (count >= limits.maxVenueAccounts) {
    return err({
      code: 'plan.limit_exceeded',
      message: `Venue account limit reached (${limits.maxVenueAccounts})`,
      limit: limits.maxVenueAccounts,
      current: count,
      params: { resource: 'venue_account', limit: limits.maxVenueAccounts, current: count },
    });
  }
  return ok(undefined);
}

/** Check if user can create a new credential */
export async function checkCredentialLimit(db: Database, config: PlansConfig, userId: string, planId: string, isAdmin: boolean): Promise<PlanCheckResult> {
  const resolved = resolvePlanForCheck(config, planId, isAdmin);
  if (resolved.isAdminBypass) return ok(undefined);
  const limits = resolved.entitlements.limits;
  // D1-cred: post-split this entitlement counts NON-trading (platform) credentials
  // only. Trading-credential quota is covered separately by checkVenueAccountLimit
  // (count_venue_accounts over the boundary).
  const rows = await db.select({ id: platformCredentials.id }).from(platformCredentials).where(eq(platformCredentials.userId, userId));
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
