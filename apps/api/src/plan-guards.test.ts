import { describe, it, expect, vi } from 'vitest';
import { checkConnectionLimit, checkLiveEnabled, checkVenueAccountLimit, resolvePlanEntitlements } from './plan-guards.js';
import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';

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
  });

  it('uses fail-closed marketplace defaults when plan definitions are missing', () => {
    const config = {
      defaultPlanId: 'missing-default',
      plans: {},
    } as unknown as PlansConfig;

    const resolved = resolvePlanEntitlements(config, { planId: 'missing', isAdmin: false });

    expect(resolved.entitlements.skills.canViewMarketplaceSkills).toBe(false);
    expect(resolved.entitlements.skills.canPublishToMarketplace).toBe(false);
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
  it('short-circuits for admins before querying the db', async () => {
    const db = { select: vi.fn() } as unknown as Database;
    const config = makePlansConfig();

    const result = await checkVenueAccountLimit(db, config, 'user-1', 'free', true);

    expect(result.ok).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
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
