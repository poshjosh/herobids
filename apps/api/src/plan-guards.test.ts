import { describe, it, expect, vi } from 'vitest';
import { checkVenueAccountLimit, checkCredentialLimit, checkTradingInstanceLimit, checkLiveEnabled } from './plan-guards.js';
import type { PlansConfig } from '@herobids/domain';
import type { Database } from '@herobids/db';

// Mock minimal plan config
function makePlansConfig(overrides: Partial<PlansConfig> = {}): PlansConfig {
  return {
    defaultPlanId: 'free',
    plans: {
      free: {
        maxPortfolios: 2,
        maxVenueAccounts: 3,
        maxCredentials: 3,
        maxTradingInstances: 2,
        maxConcurrentBacktests: 1,
        maxAgents: 3,
        liveEnabled: false,
        skills: {
          autoPublishCreatedSkills: true,
          canKeepSkillsPrivate: false,
          canChargeForSkills: false,
        },
      },
      pro: {
        maxPortfolios: 10,
        maxVenueAccounts: 20,
        maxCredentials: 20,
        maxTradingInstances: 10,
        maxConcurrentBacktests: 5,
        maxAgents: 20,
        liveEnabled: true,
        skills: {
          autoPublishCreatedSkills: false,
          canKeepSkillsPrivate: true,
          canChargeForSkills: true,
        },
      },
    },
    ...overrides,
  };
}

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

// DB-dependent tests would require integration setup. Here we test the sync-only function.
// checkPortfolioLimit, checkVenueAccountLimit etc. require a real DB connection.
// They are implicitly tested by integration/e2e tests.
