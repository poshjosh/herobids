import { describe, it, expect } from 'vitest';
import {
  resolveRiskField,
  resolveAgentRiskContract,
  validateRiskOverride,
  type AgentRiskCreatorInput,
  type AgentRiskCeilings,
  type AgentRiskOverrides,
} from './agent-risk-contract.js';

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
