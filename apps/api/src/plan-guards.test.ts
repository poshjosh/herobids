import { describe, it, expect, vi } from 'vitest';
import { checkConnectionLimit, checkLiveEnabled, checkVenueAccountLimit, resolvePlanEntitlements } from './plan-guards.js';
import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';

/**
 * A stubbed TradertonClient whose `invoke` resolves to a scripted result. The
 * venue-account count is now sourced from the boundary (`count_venue_accounts`),
 * so the limit check calls this instead of the local DB.
 */
function makeTradertonClient(result: TradertonClientResult): { client: TradertonClient; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn().mockResolvedValue(result);
  return { client: { invoke } as unknown as TradertonClient, invoke };
}

function countResult(count: number): TradertonClientResult {
  return { kind: 'success', requestId: 'r', correlationId: 'c', payload: { count } };
}

// Mock minimal plan config
function makePlansConfig(overrides: Partial<PlansConfig> = {}): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        entitlements: {
          skills: {
            canCreatePrivateSkills: false,
            canViewMarketplaceSkills: true,
            canPublishToMarketplace: true,
            autoPublishNonDraftSkills: true,
            canPriceSkills: false,
            canLikeMarketplaceSkills: true,
          },
          agents: {
            canViewOwnPrompts: false,
          },
          blueprints: {
            canViewMarketplaceBlueprints: true,
            canLikeMarketplaceBlueprints: true,
          },
          limits: {
            maxAgents: 3,
            maxBots: 2,
            maxConnections: 2,
            maxCredentials: 3,
            maxBindings: 2,
            maxVenueAccounts: 3,
            maxConcurrentBacktests: 1,
            liveEnabled: false,
          },
        },
        usage: {},
      },
      pro: {
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
            maxAgents: 20,
            maxBots: 10,
            maxConnections: 20,
            maxCredentials: 20,
            maxBindings: 20,
            maxVenueAccounts: 20,
            maxConcurrentBacktests: 5,
            liveEnabled: true,
          },
        },
        usage: {},
      },
    },
    ...overrides,
  };
}

describe('resolvePlanEntitlements', () => {
  it('falls back to default plan when requested plan does not exist', () => {
    const config = makePlansConfig();

    const resolved = resolvePlanEntitlements(config, { planId: 'unknown', isAdmin: false });

    expect(resolved.planId).toBe('free');
    expect(resolved.entitlements.skills.autoPublishNonDraftSkills).toBe(true);
  });

  it('applies admin bypass with permissive feature flags', () => {
    const config = makePlansConfig();

    const resolved = resolvePlanEntitlements(config, { planId: 'free', isAdmin: true });

    expect(resolved.isAdminBypass).toBe(true);
    expect(resolved.entitlements.skills.canPriceSkills).toBe(true);
    expect(resolved.entitlements.agents.canViewOwnPrompts).toBe(true);
    expect(resolved.entitlements.limits.liveEnabled).toBe(true);
    expect(resolved.entitlements.blueprints.canViewMarketplaceBlueprints).toBe(true);
    expect(resolved.entitlements.blueprints.canLikeMarketplaceBlueprints).toBe(true);
  });

  it('uses fail-closed marketplace defaults when plan definitions are missing', () => {
    const config = {
      defaultPlanId: 'missing-default',
      plans: {},
    } as unknown as PlansConfig;

    const resolved = resolvePlanEntitlements(config, { planId: 'missing', isAdmin: false });

    expect(resolved.entitlements.skills.canViewMarketplaceSkills).toBe(false);
    expect(resolved.entitlements.skills.canPublishToMarketplace).toBe(false);
    expect(resolved.entitlements.blueprints.canViewMarketplaceBlueprints).toBe(false);
    expect(resolved.entitlements.blueprints.canLikeMarketplaceBlueprints).toBe(false);
  });
});

describe('checkLiveEnabled', () => {
  const config = makePlansConfig();

  it('returns error when plan disallows live', () => {
    const result = checkLiveEnabled(config, 'free');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('plan.live_disabled');
    }
  });

  it('returns ok when plan allows live', () => {
    const result = checkLiveEnabled(config, 'pro');
    expect(result.ok).toBe(true);
  });

  it('falls back to default plan for unknown planId', () => {
    const result = checkLiveEnabled(config, 'nonexistent');
    expect(result.ok).toBe(false); // defaults to free which has liveEnabled: false
  });

  it('allows live execution for admins regardless of plan', () => {
    const result = checkLiveEnabled(config, 'free', true);
    expect(result.ok).toBe(true);
  });
});

describe('checkVenueAccountLimit', () => {
  it('short-circuits for admins before calling the boundary', async () => {
    const { client, invoke } = makeTradertonClient(countResult(99));
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', true);

    expect(result.ok).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows creation when the boundary count is under the plan limit', async () => {
    const { client, invoke } = makeTradertonClient(countResult(2)); // free maxVenueAccounts = 3
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0]![0];
    expect(call.toolName).toBe('count_venue_accounts');
    expect(call.payload).toEqual({});
    expect(call.subject).toEqual({ ownerId: 'user-1', actor: { type: 'user', id: 'user-1' } });
  });

  it('rejects with plan.limit_exceeded when the boundary count is at the limit', async () => {
    const { client } = makeTradertonClient(countResult(3)); // free maxVenueAccounts = 3
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('plan.limit_exceeded');
      expect(result.error.limit).toBe(3);
      expect(result.error.current).toBe(3);
      expect(result.error.params).toEqual({ resource: 'venue_account', limit: 3, current: 3 });
    }
  });

  it('rejects with plan.limit_exceeded when the boundary count is over the limit', async () => {
    const { client } = makeTradertonClient(countResult(5));
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plan.limit_exceeded');
  });

  it('fails closed with precondition.not_ready when no boundary client is configured', async () => {
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(undefined, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('precondition.not_ready');
      expect(result.error.params).toEqual({ resource: 'venue_account' });
    }
  });

  it('fails closed with precondition.not_ready on a boundary failure', async () => {
    const { client } = makeTradertonClient({
      kind: 'failure',
      requestId: 'r',
      correlationId: 'c',
      code: 'upstream.transient',
      message: 'boundary error',
      retryable: true,
    });
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('precondition.not_ready');
  });

  it('fails closed with precondition.not_ready on a transport error', async () => {
    const { client } = makeTradertonClient({ kind: 'transport_error', requestId: 'r', retryable: true, message: 'boundary down' });
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('precondition.not_ready');
  });

  it('fails closed with precondition.not_ready when the boundary is in progress', async () => {
    const { client } = makeTradertonClient({ kind: 'in_progress', requestId: 'r', correlationId: 'c' });
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('precondition.not_ready');
  });

  it('fails closed with precondition.not_ready when the payload has no numeric count', async () => {
    const { client } = makeTradertonClient({ kind: 'success', requestId: 'r', correlationId: 'c', payload: { count: 'nope' } });
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(client, config, 'user-1', 'free', false);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('precondition.not_ready');
  });
});

describe('checkConnectionLimit', () => {
  it('short-circuits for admins before querying the db', async () => {
    const db = { select: vi.fn() } as unknown as Database;
    const config = makePlansConfig();

    const result = await checkConnectionLimit(db, config, 'user-1', 'free', true);

    expect(result.ok).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });
});

// DB-dependent tests would require integration setup. Here we test the sync-only function.
// checkPortfolioLimit, checkVenueAccountLimit etc. require a real DB connection.
// They are implicitly tested by integration/e2e tests.
