import { describe, it, expect } from 'vitest';
import type { PlansConfig } from './config/index.js';
import {
  resolvePlanEntitlements,
  resolvePlanSkillEntitlements,
  resolvePlanAgentEntitlements,
  resolvePlanLimitEntitlements,
  resolvePlanBlueprintEntitlements,
  resolvePlanForCheck,
  checkLiveEnabled,
} from './plan-entitlements.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// resolvePlanEntitlements
// ---------------------------------------------------------------------------

describe('resolvePlanEntitlements', () => {
  it('returns the requested plan entitlements for a known plan', () => {
    const config = makePlansConfig();
    const resolved = resolvePlanEntitlements(config, { planId: 'pro', isAdmin: false });

    expect(resolved.planId).toBe('pro');
    expect(resolved.isAdminBypass).toBe(false);
    expect(resolved.entitlements).toEqual(config.plans.pro.entitlements);
  });

  it('falls back to the default plan when the requested plan does not exist', () => {
    const config = makePlansConfig();
    const resolved = resolvePlanEntitlements(config, { planId: 'unknown', isAdmin: false });

    expect(resolved.planId).toBe('free');
    expect(resolved.isAdminBypass).toBe(false);
    expect(resolved.entitlements).toEqual(config.plans.free.entitlements);
  });

  it('applies admin bypass with permissive feature flags', () => {
    const config = makePlansConfig();
    const resolved = resolvePlanEntitlements(config, { planId: 'free', isAdmin: true });

    expect(resolved.isAdminBypass).toBe(true);

    // Skills: all flags true except autoPublishNonDraftSkills
    expect(resolved.entitlements.skills).toEqual({
      canCreatePrivateSkills: true,
      canViewMarketplaceSkills: true,
      canPublishToMarketplace: true,
      autoPublishNonDraftSkills: false,
      canPriceSkills: true,
      canLikeMarketplaceSkills: true,
    });

    // Agents
    expect(resolved.entitlements.agents.canViewOwnPrompts).toBe(true);

    // Blueprints
    expect(resolved.entitlements.blueprints.canViewMarketplaceBlueprints).toBe(true);
    expect(resolved.entitlements.blueprints.canLikeMarketplaceBlueprints).toBe(true);

    // Limits: preserves plan limits but forces liveEnabled true
    expect(resolved.entitlements.limits.liveEnabled).toBe(true);
    expect(resolved.entitlements.limits.maxAgents).toBe(config.plans.free.entitlements.limits.maxAgents);
  });

  it('admin bypass preserves numeric limits from the resolved plan', () => {
    const config = makePlansConfig();
    const resolved = resolvePlanEntitlements(config, { planId: 'pro', isAdmin: true });

    expect(resolved.entitlements.limits.maxAgents).toBe(20);
    expect(resolved.entitlements.limits.maxBots).toBe(10);
    expect(resolved.entitlements.limits.maxConcurrentBacktests).toBe(5);
  });

  it('uses ABSOLUTE_FALLBACK_ENTITLEMENTS when neither plan nor default exist', () => {
    const config = {
      defaultPlanId: 'missing-default',
      plans: {},
    } as unknown as PlansConfig;

    const resolved = resolvePlanEntitlements(config, { planId: 'missing', isAdmin: false });

    // Fail-closed: marketplace features disabled
    expect(resolved.entitlements.skills.canViewMarketplaceSkills).toBe(false);
    expect(resolved.entitlements.skills.canPublishToMarketplace).toBe(false);
    expect(resolved.entitlements.skills.canPriceSkills).toBe(false);
    expect(resolved.entitlements.skills.autoPublishNonDraftSkills).toBe(false);
    // Private skills still allowed
    expect(resolved.entitlements.skills.canCreatePrivateSkills).toBe(true);
    expect(resolved.entitlements.skills.canLikeMarketplaceSkills).toBe(true);

    // Blueprints disabled
    expect(resolved.entitlements.blueprints.canViewMarketplaceBlueprints).toBe(false);
    expect(resolved.entitlements.blueprints.canLikeMarketplaceBlueprints).toBe(false);

    // Strict limits
    expect(resolved.entitlements.limits.maxAgents).toBe(0);
    expect(resolved.entitlements.limits.liveEnabled).toBe(false);
  });

  it('uses fallback planId "free" when planId is empty and plans are missing', () => {
    const config = {
      defaultPlanId: 'gone',
      plans: {},
    } as unknown as PlansConfig;

    const resolved = resolvePlanEntitlements(config, { planId: '', isAdmin: false });

    expect(resolved.planId).toBe('free');
    expect(resolved.isAdminBypass).toBe(false);
  });

  it('returns the default planId (not the requested one) when falling back', () => {
    const config = makePlansConfig({ defaultPlanId: 'free' });
    const resolved = resolvePlanEntitlements(config, { planId: 'enterprise', isAdmin: false });

    expect(resolved.planId).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

describe('resolvePlanSkillEntitlements', () => {
  it('returns the skills sub-object for a known plan', () => {
    const config = makePlansConfig();
    const skills = resolvePlanSkillEntitlements(config, 'pro');

    expect(skills).toEqual(config.plans.pro.entitlements.skills);
  });

  it('defaults isAdmin to false', () => {
    const config = makePlansConfig();
    const skills = resolvePlanSkillEntitlements(config, 'free');

    // free plan has canPriceSkills false; admin bypass would make it true
    expect(skills.canPriceSkills).toBe(false);
  });

  it('applies admin bypass when isAdmin is true', () => {
    const config = makePlansConfig();
    const skills = resolvePlanSkillEntitlements(config, 'free', true);

    expect(skills.canPriceSkills).toBe(true);
    expect(skills.canPublishToMarketplace).toBe(true);
  });
});

describe('resolvePlanAgentEntitlements', () => {
  it('returns the agents sub-object for a known plan', () => {
    const config = makePlansConfig();
    const agents = resolvePlanAgentEntitlements(config, 'free');

    expect(agents).toEqual(config.plans.free.entitlements.agents);
  });

  it('applies admin bypass when isAdmin is true', () => {
    const config = makePlansConfig();
    const agents = resolvePlanAgentEntitlements(config, 'free', true);

    expect(agents.canViewOwnPrompts).toBe(true);
  });
});

describe('resolvePlanLimitEntitlements', () => {
  it('returns the limits sub-object for a known plan', () => {
    const config = makePlansConfig();
    const limits = resolvePlanLimitEntitlements(config, 'pro');

    expect(limits).toEqual(config.plans.pro.entitlements.limits);
  });

  it('applies admin bypass to force liveEnabled true', () => {
    const config = makePlansConfig();
    const limits = resolvePlanLimitEntitlements(config, 'free', true);

    expect(limits.liveEnabled).toBe(true);
  });
});

describe('resolvePlanBlueprintEntitlements', () => {
  it('returns the blueprints sub-object for a known plan', () => {
    const config = makePlansConfig();
    const blueprints = resolvePlanBlueprintEntitlements(config, 'free');

    expect(blueprints).toEqual(config.plans.free.entitlements.blueprints);
  });

  it('applies admin bypass when isAdmin is true', () => {
    const config = makePlansConfig();
    const blueprints = resolvePlanBlueprintEntitlements(config, 'free', true);

    expect(blueprints.canViewMarketplaceBlueprints).toBe(true);
    expect(blueprints.canLikeMarketplaceBlueprints).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePlanForCheck
// ---------------------------------------------------------------------------

describe('resolvePlanForCheck', () => {
  it('returns the same result as resolvePlanEntitlements', () => {
    const config = makePlansConfig();
    const fromCheck = resolvePlanForCheck(config, 'pro', false);
    const fromResolve = resolvePlanEntitlements(config, { planId: 'pro', isAdmin: false });

    expect(fromCheck).toEqual(fromResolve);
  });

  it('passes admin flag through correctly', () => {
    const config = makePlansConfig();
    const resolved = resolvePlanForCheck(config, 'free', true);

    expect(resolved.isAdminBypass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkLiveEnabled
// ---------------------------------------------------------------------------

describe('checkLiveEnabled', () => {
  it('returns error when plan disallows live', () => {
    const config = makePlansConfig();
    const result = checkLiveEnabled(config, 'free');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('plan.live_disabled');
      expect(result.error.message).toBe('Live trading is not available on your current plan');
      expect(result.error.limit).toBe(0);
      expect(result.error.current).toBe(0);
      expect(result.error.params).toEqual({ resource: 'live_trading' });
    }
  });

  it('returns ok when plan allows live', () => {
    const config = makePlansConfig();
    const result = checkLiveEnabled(config, 'pro');

    expect(result.ok).toBe(true);
  });

  it('returns ok for admin bypass regardless of plan', () => {
    const config = makePlansConfig();
    const result = checkLiveEnabled(config, 'free', true);

    expect(result.ok).toBe(true);
  });

  it('falls back to default plan for unknown planId', () => {
    const config = makePlansConfig();
    // default is 'free' which has liveEnabled: false
    const result = checkLiveEnabled(config, 'nonexistent');

    expect(result.ok).toBe(false);
  });

  it('defaults isAdmin to false', () => {
    const config = makePlansConfig();
    // free plan has liveEnabled: false, so without admin it should fail
    const result = checkLiveEnabled(config, 'free');

    expect(result.ok).toBe(false);
  });

  it('uses ABSOLUTE_FALLBACK when no plans exist (liveEnabled: false)', () => {
    const config = {
      defaultPlanId: 'missing',
      plans: {},
    } as unknown as PlansConfig;

    const result = checkLiveEnabled(config, 'anything', false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('plan.live_disabled');
    }
  });

  it('admin bypass works even when no plans exist', () => {
    const config = {
      defaultPlanId: 'missing',
      plans: {},
    } as unknown as PlansConfig;

    const result = checkLiveEnabled(config, 'anything', true);

    expect(result.ok).toBe(true);
  });
});
