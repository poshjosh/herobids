import { describe, it, expect } from 'vitest';
import {
  buildAgentRiskLimits,
  resolveContract,
  extractCreatorInput,
  extractCeilings,
  buildRiskLimitsFromContract,
} from './agent-risk-limits.js';
import type { AgentRiskLimitSource } from './agent-risk-limits.js';
import type { AgentRiskDefaultsConfig, AgentRiskOverrides } from '@herobids/domain';
import type { RiskLimits } from '@herobids/engine';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function source(overrides: Partial<AgentRiskLimitSource> = {}): AgentRiskLimitSource {
  return {
    capital: '10000',
    dailyLossLimit: null,
    maxDrawdownPct: null,
    maxOpenPositions: null,
    maxPositionSizePct: null,
    stopLossPct: null,
    stopLossCooldownMs: null,
    ...overrides,
  };
}

function defaults(overrides: Partial<AgentRiskDefaultsConfig> = {}): AgentRiskDefaultsConfig {
  return {
    dailyLossLimitDefaultRatio: 0.05,
    maxOpenPositions: 10,
    maxPositionSizePct: 100,
    maxPositionSize: 1_000_000,
    stopLossMaxUnrealizedLossPct: 10,
    dailyMaxLossPct: 20,
    stopLossCooldownMs: 300_000,
    maxOrderNotionalMultiplier: 1,
    botConfigInvalidHaltThreshold: 1,
    botExecutionErrorHaltThreshold: 5,
    botLlmProviderErrorHaltThreshold: 1,
    agentDecisionNoContextThreshold: 10,
    agentDecisionSwapInstrumentFormatThreshold: 5,
    maxDrawdown: 1_000_000_000,
    maxDrawdownPct: 20,
    perTradeLevelMonitorIntervalMs: 5000,
    maxBots: 5,
    ...overrides,
  };
}

function overrides(overrides: Partial<AgentRiskOverrides> = {}): AgentRiskOverrides {
  return { ...overrides };
}

// ---------------------------------------------------------------------------
// extractCeilings — maps operator defaults to contract ceilings
// ---------------------------------------------------------------------------

describe('extractCeilings', () => {
  it('maps operator defaults to contract ceiling names', () => {
    const d = defaults({ maxOpenPositions: 10, maxPositionSizePct: 50, stopLossCooldownMs: 300_000, maxDrawdownPct: 15 });
    const ceilings = extractCeilings(d);
    expect(ceilings).toEqual({
      maxOpenPositions: 10,
      maxPositionSizePct: 50,
      // The extractCeilings bridge maps stopLossMaxUnrealizedLossPct → stopLossPct
      stopLossPct: d.stopLossMaxUnrealizedLossPct,
      stopLossCooldownMs: 300_000,
      maxDrawdownPct: 15,
    });
  });

  it('maps stopLossMaxUnrealizedLossPct operator default to stopLossPct', () => {
    const d = defaults({ stopLossMaxUnrealizedLossPct: 7 });
    const ceilings = extractCeilings(d);
    expect(ceilings.stopLossPct).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// extractCreatorInput — parses raw nullable source columns
// ---------------------------------------------------------------------------

describe('extractCreatorInput', () => {
  it('parses string numeric fields', () => {
    const input = extractCreatorInput(
      source({ maxPositionSizePct: '25', stopLossPct: '5', maxDrawdownPct: '10' }),
    );
    expect(input).toEqual({
      maxOpenPositions: null,
      maxPositionSizePct: 25,
      stopLossPct: 5,
      stopLossCooldownMs: null,
      maxDrawdownPct: 10,
    });
  });

  it('parses number fields directly', () => {
    const input = extractCreatorInput(
      source({ maxPositionSizePct: 25, stopLossPct: 5, maxDrawdownPct: 10 }),
    );
    expect(input).toEqual({
      maxOpenPositions: null,
      maxPositionSizePct: 25,
      stopLossPct: 5,
      stopLossCooldownMs: null,
      maxDrawdownPct: 10,
    });
  });

  it('returns null for null/absent fields', () => {
    const input = extractCreatorInput(source());
    expect(input).toEqual({
      maxOpenPositions: null,
      maxPositionSizePct: null,
      stopLossPct: null,
      stopLossCooldownMs: null,
      maxDrawdownPct: null,
    });
  });

  it('returns null for non-finite string values', () => {
    const input = extractCreatorInput(
      source({ maxPositionSizePct: 'not-a-number' }),
    );
    expect(input.maxPositionSizePct).toBeNull();
  });

  it('returns null for NaN', () => {
    const input = extractCreatorInput(
      source({ maxPositionSizePct: NaN }),
    );
    expect(input.maxPositionSizePct).toBeNull();
  });

  it('passes through non-risk integer fields (maxOpenPositions, stopLossCooldownMs)', () => {
    const input = extractCreatorInput(
      source({ maxOpenPositions: 5, stopLossCooldownMs: 120_000 }),
    );
    expect(input.maxOpenPositions).toBe(5);
    expect(input.stopLossCooldownMs).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// resolveContract — three provenance paths
// ---------------------------------------------------------------------------

describe('resolveContract', () => {
  // --- Path 1: Creator-set / immutable ---

  it('marks creator-set fields as immutable with source=user', () => {
    const contract = resolveContract(
      source({ maxOpenPositions: 3, stopLossPct: '5' }),
      defaults({ maxOpenPositions: 10, stopLossMaxUnrealizedLossPct: 10 }),
    );

    expect(contract.maxOpenPositions.effectiveValue).toBe(3);
    expect(contract.maxOpenPositions.source).toBe('user');
    expect(contract.maxOpenPositions.mutable).toBe(false);
    expect(contract.maxOpenPositions.creatorValue).toBe(3);

    expect(contract.stopLossPct.effectiveValue).toBe(5);
    expect(contract.stopLossPct.source).toBe('user');
    expect(contract.stopLossPct.mutable).toBe(false);
    expect(contract.stopLossPct.creatorValue).toBe(5);
  });

  it('sets operatorCeiling on creator-set fields', () => {
    const contract = resolveContract(
      source({ maxOpenPositions: 3 }),
      defaults({ maxOpenPositions: 10 }),
    );
    expect(contract.maxOpenPositions.operatorCeiling).toBe(10);
  });

  // --- Path 2: Operator-default / agent-mutable ---

  it('falls back to operator default when creator input is null', () => {
    const contract = resolveContract(
      source(), // all null
      defaults({ maxOpenPositions: 10, maxPositionSizePct: 50 }),
    );

    expect(contract.maxOpenPositions.effectiveValue).toBe(10);
    expect(contract.maxOpenPositions.source).toBe('default');
    expect(contract.maxOpenPositions.mutable).toBe(true);

    expect(contract.maxPositionSizePct.effectiveValue).toBe(50);
    expect(contract.maxPositionSizePct.source).toBe('default');
    expect(contract.maxPositionSizePct.mutable).toBe(true);
  });

  // --- Path 3: Agent-override / mutable (capped at ceiling) ---

  it('applies agent override when creator input is null and override present', () => {
    const contract = resolveContract(
      source(), // all null
      defaults({ maxOpenPositions: 10 }),
      overrides({ maxOpenPositions: 7 }),
    );

    expect(contract.maxOpenPositions.effectiveValue).toBe(7);
    expect(contract.maxOpenPositions.source).toBe('agent_override');
    expect(contract.maxOpenPositions.mutable).toBe(true);
    expect(contract.maxOpenPositions.overrideValue).toBe(7);
  });

  it('caps agent override at operator ceiling', () => {
    const contract = resolveContract(
      source(), // all null
      defaults({ maxOpenPositions: 10 }),
      overrides({ maxOpenPositions: 50 }), // exceeds ceiling of 10
    );

    expect(contract.maxOpenPositions.effectiveValue).toBe(10); // capped
    expect(contract.maxOpenPositions.source).toBe('agent_override');
    expect(contract.maxOpenPositions.mutable).toBe(true);
    expect(contract.maxOpenPositions.overrideValue).toBe(10); // capped value stored
  });

  it('ignores agent override when creator set the field (immutable)', () => {
    const contract = resolveContract(
      source({ maxOpenPositions: 5 }), // creator-set
      defaults({ maxOpenPositions: 10 }),
      overrides({ maxOpenPositions: 3 }), // agent tries to override
    );

    // Creator wins — override is ignored
    expect(contract.maxOpenPositions.effectiveValue).toBe(5);
    expect(contract.maxOpenPositions.source).toBe('user');
    expect(contract.maxOpenPositions.mutable).toBe(false);
  });

  // --- hasCapital: false ---

  it('marks maxPositionSizePct as unenforced when source is default and hasCapital is false', () => {
    const contract = resolveContract(
      source({ capital: null }), // no capital
      defaults({ maxPositionSizePct: 100 }),
    );

    expect(contract.maxPositionSizePct.effectiveValue).toBe(100);
    expect(contract.maxPositionSizePct.source).toBe('default');
    expect(contract.maxPositionSizePct.enforced).toBe(false);
  });

  it('keeps maxPositionSizePct enforced when source is user even without capital', () => {
    const contract = resolveContract(
      source({ capital: null, maxPositionSizePct: '25' }),
      defaults({ maxPositionSizePct: 100 }),
    );

    expect(contract.maxPositionSizePct.effectiveValue).toBe(25);
    expect(contract.maxPositionSizePct.source).toBe('user');
    expect(contract.maxPositionSizePct.enforced).toBeUndefined(); // user-intent preserves enforcement
  });

  it('keeps maxPositionSizePct enforced when source is agent_override even without capital', () => {
    const contract = resolveContract(
      source({ capital: null }),
      defaults({ maxPositionSizePct: 100 }),
      overrides({ maxPositionSizePct: 30 }),
    );

    expect(contract.maxPositionSizePct.effectiveValue).toBe(30);
    expect(contract.maxPositionSizePct.source).toBe('agent_override');
    expect(contract.maxPositionSizePct.enforced).toBeUndefined(); // agent intent preserves enforcement
  });

  it('resolves contract with exactly five risk fields and no extra keys', () => {
    const contract = resolveContract(source(), defaults());
    const keys = Object.keys(contract).sort();
    expect(keys).toEqual([
      'maxDrawdownPct',
      'maxOpenPositions',
      'maxPositionSizePct',
      'stopLossCooldownMs',
      'stopLossPct',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildRiskLimitsFromContract — projects contract into engine RiskLimits
// ---------------------------------------------------------------------------

describe('buildRiskLimitsFromContract', () => {
  it('projects resolved contract fields into engine RiskLimits', () => {
    const d = defaults({ maxPositionSize: 500_000, maxDrawdown: 1_000_000 });
    const contract = resolveContract(
      source({ capital: '10000', maxOpenPositions: 3 }),
      d,
    );

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000' }), d);

    expect(limits.maxPositionSize.toString()).toBe('500000');
    expect(limits.maxOpenPositions).toBe(3);
    expect(limits.maxDrawdownPct).toBe(20); // from operator default
    expect(limits.stopLossMaxUnrealizedLossPct).toBe(10); // from operator default, mapped from stopLossPct
    expect(limits.stopLossCooldownMs).toBe(300_000);
    expect(limits.maxPositionSizePct).toBe(100);
  });

  it('returns dailyMaxLossPct derived from capital and daily loss limit', () => {
    const d = defaults();
    const contract = resolveContract(source({ capital: '10000', dailyLossLimit: '500' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000', dailyLossLimit: '500' }), d);

    // 500 / 10000 * 100 = 5%
    expect(limits.dailyMaxLossPct).toBe(5);
  });

  it('returns dailyMaxLossPct as zero when dailyLossLimit is "0"', () => {
    // Zero loss limit → derived percent is 0, meaning any non-zero daily loss will be rejected
    const d = defaults();
    const contract = resolveContract(source({ capital: '10000', dailyLossLimit: '0' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000', dailyLossLimit: '0' }), d);

    expect(limits.dailyMaxLossPct).toBe(0);
  });

  it('returns negative dailyMaxLossPct when dailyLossLimit is negative', () => {
    const d = defaults();
    const contract = resolveContract(source({ capital: '10000', dailyLossLimit: '-100' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000', dailyLossLimit: '-100' }), d);

    // -100 / 10000 * 100 = -1%
    expect(limits.dailyMaxLossPct).toBe(-1);
  });

  it('falls back to operator default for dailyMaxLossPct when dailyLossLimit is absent', () => {
    const d = defaults({ dailyMaxLossPct: 20 });
    const contract = resolveContract(source({ capital: '10000' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000' }), d);

    expect(limits.dailyMaxLossPct).toBe(20);
  });

  it('derives maxOrderNotional from capital × maxOrderNotionalMultiplier', () => {
    const d = defaults({ maxOrderNotionalMultiplier: 1 });
    const contract = resolveContract(source({ capital: '10000' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000' }), d);

    expect(limits.maxOrderNotional?.toString()).toBe('10000');
  });

  it('omits maxOrderNotional and dailyMaxLossPct when capital is absent', () => {
    const d = defaults();
    const contract = resolveContract(source({ capital: null }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: null }), d);

    expect(limits.maxOrderNotional).toBeUndefined();
    expect(limits.dailyMaxLossPct).toBeUndefined();
  });

  it('sets maxDrawdown from operator ceiling', () => {
    const d = defaults({ maxDrawdown: 500_000 });
    const contract = resolveContract(source({ capital: '10000' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000' }), d);

    expect(limits.maxDrawdown.toString()).toBe('500000');
  });

  it('includes maxPositionSizePct when source is user-set even without capital', () => {
    const d = defaults();
    const contract = resolveContract(
      source({ capital: null, maxPositionSizePct: '30' }),
      d,
    );

    const limits = buildRiskLimitsFromContract(contract, source({ capital: null }), d);

    expect(limits.maxPositionSizePct).toBe(30);
  });

  it('includes maxPositionSizePct when capital is present', () => {
    const d = defaults();
    const contract = resolveContract(source({ capital: '10000' }), d);

    const limits = buildRiskLimitsFromContract(contract, source({ capital: '10000' }), d);

    expect(limits.maxPositionSizePct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildAgentRiskLimits — end-to-end composition
// ---------------------------------------------------------------------------

describe('buildAgentRiskLimits', () => {
  it('returns full RiskLimits from source + defaults (no overrides)', () => {
    const result = buildAgentRiskLimits(
      source({ capital: '10000', maxOpenPositions: 3 }),
      defaults({ maxOpenPositions: 10, maxDrawdownPct: 15, maxPositionSize: 500_000 }),
    );

    expect(result.maxOpenPositions).toBe(3); // creator-set
    expect(result.maxDrawdownPct).toBe(15); // operator default
    expect(result.maxPositionSize.toString()).toBe('500000');
  });

  it('applies agent overrides when creator did not set the field', () => {
    const result = buildAgentRiskLimits(
      source({ capital: '10000' }), // no creator-set risk fields
      defaults({ maxOpenPositions: 10 }),
      overrides({ maxOpenPositions: 5 }),
    );

    expect(result.maxOpenPositions).toBe(5); // agent override
  });

  // --- Mutable set assertions ---

  it('exposes maxOpenPositions, maxPositionSizePct, stopLossPct, stopLossCooldownMs, maxDrawdownPct as mutable', () => {
    const contract = resolveContract(source(), defaults());

    // The five mutable fields:
    const mutableFields = ['maxOpenPositions', 'maxPositionSizePct', 'stopLossPct', 'stopLossCooldownMs', 'maxDrawdownPct'] as const;

    for (const field of mutableFields) {
      expect(contract[field].mutable).toBe(true);
    }
  });

  it('reports dailyMaxLossPct as non-mutable', () => {
    // dailyMaxLossPct is not part of the contract at all — it is derived in buildRiskLimitsFromContract
    const contract = resolveContract(source(), defaults());
    // The contract doesn't even have a dailyMaxLossPct field
    expect(contract).not.toHaveProperty('dailyMaxLossPct');
  });

  it('reports maxOrderNotional as non-mutable', () => {
    // maxOrderNotional is derived in buildRiskLimitsFromContract, not part of the contract
    const contract = resolveContract(source(), defaults());
    expect(contract).not.toHaveProperty('maxOrderNotional');
  });

  // --- Edge: all fields creator-set → all immutable ---

  it('marks all five contract fields immutable when all are creator-set', () => {
    const contract = resolveContract(
      source({
        maxOpenPositions: 3,
        maxPositionSizePct: '25',
        stopLossPct: '5',
        stopLossCooldownMs: 120_000,
        maxDrawdownPct: '10',
      }),
      defaults(),
    );

    expect(contract.maxOpenPositions.mutable).toBe(false);
    expect(contract.maxPositionSizePct.mutable).toBe(false);
    expect(contract.stopLossPct.mutable).toBe(false);
    expect(contract.stopLossCooldownMs.mutable).toBe(false);
    expect(contract.maxDrawdownPct.mutable).toBe(false);
  });

  // --- Edge: capital present triggers dailyLoss/dailyMaxLossPct derivation ---

  it('derives dailyMaxLossPct from dailyLossLimit when capital and dailyLossLimit present', () => {
    const result = buildAgentRiskLimits(
      source({ capital: '10000', dailyLossLimit: '200' }),
      defaults({ dailyMaxLossPct: 20 }),
    );

    // 200 / 10000 * 100 = 2%
    expect(result.dailyMaxLossPct).toBe(2);
  });

  it('uses operator dailyMaxLossPct when dailyLossLimit is null', () => {
    const result = buildAgentRiskLimits(
      source({ capital: '10000', dailyLossLimit: null }),
      defaults({ dailyMaxLossPct: 20 }),
    );

    expect(result.dailyMaxLossPct).toBe(20);
  });

  it('omits maxOrderNotional and dailyMaxLossPct from output when capital is null', () => {
    const result = buildAgentRiskLimits(
      source({ capital: null }),
      defaults(),
    );

    expect(result.maxOrderNotional).toBeUndefined();
    expect(result.dailyMaxLossPct).toBeUndefined();
  });
});
