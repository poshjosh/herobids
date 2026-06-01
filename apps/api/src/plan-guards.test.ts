import { describe, it, expect } from 'vitest';
import { checkPortfolioLimit, checkVenueAccountLimit, checkCredentialLimit, checkTradingInstanceLimit, checkLiveEnabled } from './plan-guards.js';
import type { PlansConfig } from '@herobids/domain';

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
        liveEnabled: false,
      },
      pro: {
        maxPortfolios: 10,
        maxVenueAccounts: 20,
        maxCredentials: 20,
        maxTradingInstances: 10,
        maxConcurrentBacktests: 5,
        liveEnabled: true,
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
});

// DB-dependent tests would require integration setup. Here we test the sync-only function.
// checkPortfolioLimit, checkVenueAccountLimit etc. require a real DB connection.
// They are implicitly tested by integration/e2e tests.
