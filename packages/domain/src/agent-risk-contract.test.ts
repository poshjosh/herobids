import { describe, it, expect } from 'vitest';
import {
  resolveRiskField,
  resolveAgentRiskContract,
  validateRiskOverride,
  resolveAgentRiskProfile,
  type AgentRiskCreatorInput,
  type AgentRiskCeilings,
  type AgentRiskCeilingsExtended,
  type AgentRiskOverrides,
  type ResolvedAgentRiskProfile,
} from './agent-risk-contract.js';
import type { RiskPosture } from './config/schema.js';

const CEILINGS: AgentRiskCeilings = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossPct: 10,
  stopLossCooldownMs: 300_000,
};

describe('resolveRiskField()', () => {
  it('resolves creator-configured field as immutable', () => {
    const field = resolveRiskField(5, 10, undefined);
    expect(field.effectiveValue).toBe(5);
    expect(field.source).toBe('user');
    expect(field.mutable).toBe(false);
    expect(field.operatorCeiling).toBe(10);
    expect(field.creatorValue).toBe(5);
    expect(field.overrideValue).toBeUndefined();
  });

  it('resolves default-derived field as mutable', () => {
    const field = resolveRiskField(null, 10, undefined);
    expect(field.effectiveValue).toBe(10);
    expect(field.source).toBe('default');
    expect(field.mutable).toBe(true);
    expect(field.operatorCeiling).toBe(10);
    expect(field.creatorValue).toBeUndefined();
    expect(field.overrideValue).toBeUndefined();
  });

  it('resolves agent override as mutable', () => {
    const field = resolveRiskField(null, 10, 7);
    expect(field.effectiveValue).toBe(7);
    expect(field.source).toBe('agent_override');
    expect(field.mutable).toBe(true);
    expect(field.operatorCeiling).toBe(10);
    expect(field.overrideValue).toBe(7);
  });

  it('caps agent override at operator ceiling', () => {
    const field = resolveRiskField(null, 10, 15);
    expect(field.effectiveValue).toBe(10);
    expect(field.overrideValue).toBe(10);
  });

  it('ignores override when creator value is present', () => {
    // Creator value takes precedence unconditionally
    const field = resolveRiskField(5, 10, 3);
    expect(field.effectiveValue).toBe(5);
    expect(field.source).toBe('user');
    expect(field.mutable).toBe(false);
  });
});

describe('resolveAgentRiskContract()', () => {
  it('resolves full contract from all sources', () => {
    const creator: AgentRiskCreatorInput = {
      maxOpenPositions: 5, // user-set
      maxPositionSizePct: null, // use default
      stopLossPct: null, // use default
      stopLossCooldownMs: null, // use default
    };
    const overrides: AgentRiskOverrides = {
      stopLossPct: 8, // agent adjusted
    };

    const contract = resolveAgentRiskContract(creator, CEILINGS, overrides);

    // Creator-configured = immutable
    expect(contract.maxOpenPositions.effectiveValue).toBe(5);
    expect(contract.maxOpenPositions.source).toBe('user');
    expect(contract.maxOpenPositions.mutable).toBe(false);

    // Default = mutable
    expect(contract.maxPositionSizePct.effectiveValue).toBe(100);
    expect(contract.maxPositionSizePct.source).toBe('default');
    expect(contract.maxPositionSizePct.mutable).toBe(true);

    // Agent override = mutable
    expect(contract.stopLossPct.effectiveValue).toBe(8);
    expect(contract.stopLossPct.source).toBe('agent_override');
    expect(contract.stopLossPct.mutable).toBe(true);

    // Default = mutable
    expect(contract.stopLossCooldownMs.effectiveValue).toBe(300_000);
    expect(contract.stopLossCooldownMs.source).toBe('default');
    expect(contract.stopLossCooldownMs.mutable).toBe(true);
  });

  it('resolves contract with no overrides (empty object)', () => {
    const creator: AgentRiskCreatorInput = {
      maxOpenPositions: null,
      maxPositionSizePct: null,
      stopLossPct: null,
      stopLossCooldownMs: null,
    };

    const contract = resolveAgentRiskContract(creator, CEILINGS, {});

    expect(contract.maxOpenPositions.source).toBe('default');
    expect(contract.maxOpenPositions.effectiveValue).toBe(10);
    expect(contract.maxPositionSizePct.source).toBe('default');
    expect(contract.stopLossPct.source).toBe('default');
    expect(contract.stopLossCooldownMs.source).toBe('default');
  });
});

describe('validateRiskOverride()', () => {
  const contract = resolveAgentRiskContract(
    { maxOpenPositions: 5, maxPositionSizePct: null, stopLossPct: null, stopLossCooldownMs: null },
    CEILINGS,
    {},
  );

  it('rejects adjustment of creator-configured (immutable) field', () => {
    const error = validateRiskOverride('maxOpenPositions', contract, 3);
    expect(error).toContain('creator-configured');
    expect(error).toContain('cannot be adjusted');
  });

  it('allows adjustment of default-derived (mutable) field', () => {
    const error = validateRiskOverride('maxPositionSizePct', contract, 50);
    expect(error).toBeUndefined();
  });

  it('rejects value above operator ceiling', () => {
    const error = validateRiskOverride('stopLossPct', contract, 15);
    expect(error).toContain('cannot exceed operator ceiling');
    expect(error).toContain('10');
  });

  it('allows reset to default (null value)', () => {
    const error = validateRiskOverride('maxPositionSizePct', contract, null);
    expect(error).toBeUndefined();
  });

  it('allows zero for fields where 0 means disabled', () => {
    const error = validateRiskOverride('stopLossCooldownMs', contract, 0);
    expect(error).toBeUndefined();
  });

  it('allows zero for stopLossPct (disabled)', () => {
    const error = validateRiskOverride('stopLossPct', contract, 0);
    expect(error).toBeUndefined();
  });

  it('rejects zero for maxOpenPositions (must be >= 1)', () => {
    // maxOpenPositions cannot be 0 — at least 1 position must be allowed
    const contractWithMutablePositions = resolveAgentRiskContract(
      { maxOpenPositions: null, maxPositionSizePct: null, stopLossPct: null, stopLossCooldownMs: null },
      CEILINGS,
      {},
    );
    const error = validateRiskOverride('maxOpenPositions', contractWithMutablePositions, 0);
    expect(error).toContain('>= 1');
  });

  it('rejects negative values', () => {
    const error = validateRiskOverride('stopLossCooldownMs', contract, -100);
    expect(error).toContain('>= 0');
  });
});

// ─── resolveAgentRiskProfile (9-field read model) ────────────────────────────

const EXTENDED_CEILINGS: AgentRiskCeilingsExtended = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossPct: 10,
  stopLossCooldownMs: 300_000,
  maxDrawdownPct: 20,
  dailyMaxLossPct: 5,
};

describe('resolveAgentRiskProfile()', () => {
  // 1. All 9 fields present with creator values → all immutable, source='user'
  it('resolves all 9 creator-configured fields as immutable', () => {
    const riskPosture: RiskPosture = {
      maxOpenPositions: 5,
      maxPositionSizePct: 50,
      stopLossPct: 8,
      stopLossCooldownMs: 60000,
      maxDrawdownPct: 15,
      dailyMaxLossPct: 3,
      maxNewPositionsPerDay: 5,
      avoidParabolicMovePct: 30,
      maxOrderNotional: 1000,
    };
    const profile = resolveAgentRiskProfile(riskPosture, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});

    // All fields should be source='user', mutable=false
    for (const [key, field] of Object.entries(profile)) {
      expect(field.source).toBe('user');
      expect(field.mutable).toBe(false);
    }
    expect(profile.maxOpenPositions.effectiveValue).toBe(5);
    expect(profile.maxOrderNotional.effectiveValue).toBe(1000);
  });

  // 2. Null riskPosture → 5 mutable fields get defaults, dailyMaxLossPct gets default, others disabled
  it('resolves null riskPosture with defaults for mutable fields and disabled for others', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});

    // 5 mutable fields: source='default', mutable=true
    expect(profile.maxOpenPositions.source).toBe('default');
    expect(profile.maxOpenPositions.mutable).toBe(true);
    expect(profile.maxOpenPositions.effectiveValue).toBe(10);

    // dailyMaxLossPct: source='default', mutable=false (immutable creator/default-only)
    expect(profile.dailyMaxLossPct.source).toBe('default');
    expect(profile.dailyMaxLossPct.mutable).toBe(false);
    expect(profile.dailyMaxLossPct.effectiveValue).toBe(5);

    // maxNewPositionsPerDay: source='disabled', effectiveValue=null
    expect(profile.maxNewPositionsPerDay.source).toBe('disabled');
    expect(profile.maxNewPositionsPerDay.effectiveValue).toBeNull();
    expect(profile.maxNewPositionsPerDay.enforced).toBe(false);

    // avoidParabolicMovePct: source='disabled'
    expect(profile.avoidParabolicMovePct.source).toBe('disabled');
    expect(profile.avoidParabolicMovePct.effectiveValue).toBeNull();

    // maxOrderNotional: source='disabled' (no capital)
    expect(profile.maxOrderNotional.source).toBe('disabled');
    expect(profile.maxOrderNotional.effectiveValue).toBeNull();
  });

  // 3. With capital → maxOrderNotional derived
  it('derives maxOrderNotional from capital when not creator-configured', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {}, {
      capital: 10000,
      maxOrderNotionalMultiplier: 1,
    });
    expect(profile.maxOrderNotional.source).toBe('derived');
    expect(profile.maxOrderNotional.effectiveValue).toBe(10000);
    expect(profile.maxOrderNotional.mutable).toBe(false);
  });

  // 4. Creator maxOrderNotional overrides derivation
  it('creator maxOrderNotional takes precedence over derivation', () => {
    const riskPosture: RiskPosture = { maxOrderNotional: 500 };
    const profile = resolveAgentRiskProfile(riskPosture, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {}, {
      capital: 10000,
      maxOrderNotionalMultiplier: 1,
    });
    expect(profile.maxOrderNotional.source).toBe('user');
    expect(profile.maxOrderNotional.effectiveValue).toBe(500);
  });

  // 5. Agent overrides on mutable fields
  it('applies agent overrides on mutable fields', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {
      maxOpenPositions: 3,
      stopLossPct: 5,
    });
    expect(profile.maxOpenPositions.source).toBe('agent_override');
    expect(profile.maxOpenPositions.effectiveValue).toBe(3);
    expect(profile.maxOpenPositions.mutable).toBe(true);
    expect(profile.stopLossPct.source).toBe('agent_override');
    expect(profile.stopLossPct.effectiveValue).toBe(5);
  });

  // 6. Creator values cannot be overridden
  it('creator-configured fields ignore overrides', () => {
    const riskPosture: RiskPosture = { maxOpenPositions: 7 };
    const profile = resolveAgentRiskProfile(riskPosture, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {
      maxOpenPositions: 3,
    });
    expect(profile.maxOpenPositions.source).toBe('user');
    expect(profile.maxOpenPositions.effectiveValue).toBe(7);
    expect(profile.maxOpenPositions.mutable).toBe(false);
  });

  // 7. operatorCeiling is null for non-mutable, non-defaulted fields
  it('operatorCeiling is null for maxNewPositionsPerDay, avoidParabolicMovePct, maxOrderNotional', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});
    expect(profile.maxNewPositionsPerDay.operatorCeiling).toBeNull();
    expect(profile.avoidParabolicMovePct.operatorCeiling).toBeNull();
    expect(profile.maxOrderNotional.operatorCeiling).toBeNull();
  });

  // 8. operatorCeiling reflects the config value for 5 mutable fields + dailyMaxLossPct
  it('operatorCeiling matches config for mutable and dailyMaxLossPct fields', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});
    expect(profile.maxOpenPositions.operatorCeiling).toBe(10);
    expect(profile.dailyMaxLossPct.operatorCeiling).toBe(5);
  });

  // 9. enforce=false when source=disabled
  it('disabled fields have enforced=false', () => {
    const profile = resolveAgentRiskProfile(null, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});
    expect(profile.maxNewPositionsPerDay.enforced).toBe(false);
    expect(profile.avoidParabolicMovePct.enforced).toBe(false);
    expect(profile.maxOrderNotional.enforced).toBe(false);
  });

  // 10. rawValue reflects the original input
  it('rawValue reflects creator input', () => {
    const riskPosture: RiskPosture = { maxOpenPositions: 5, dailyMaxLossPct: 3 };
    const profile = resolveAgentRiskProfile(riskPosture, EXTENDED_CEILINGS, EXTENDED_CEILINGS.dailyMaxLossPct, {});
    expect(profile.maxOpenPositions.rawValue).toBe(5); // creator-configured
    expect(profile.dailyMaxLossPct.rawValue).toBe(3);
    expect(profile.maxNewPositionsPerDay.rawValue).toBeNull(); // disabled
  });
});
