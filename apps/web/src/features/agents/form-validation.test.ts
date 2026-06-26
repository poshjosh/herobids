import { describe, expect, it } from 'vitest';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';

const DEFAULT_CONSTRAINTS: ValidationConstraints = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossMaxUnrealizedLossPct: 100,
};

function validIntent(overrides: Partial<Parameters<typeof validateCreateAgentForm>[0]> = {}) {
  return {
    name: 'test-agent',
    goal: 'Trade BTC',
    capabilityMode: 'both' as const,
    capital: '1000',
    tickIntervalMins: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    executionMode: 'paper',
    requiresTradingSetup: true,
    ...overrides,
  };
}

describe('validateCreateAgentForm', () => {
  it('returns valid true with empty errors when all fields are valid', () => {
    const result = validateCreateAgentForm(validIntent(), DEFAULT_CONSTRAINTS);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('returns error for missing name', () => {
    const result = validateCreateAgentForm(validIntent({ name: '' }), DEFAULT_CONSTRAINTS);
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it('returns error for missing goal in intelligence mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'intelligence', requiresTradingSetup: false }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.goal).toBeDefined();
  });

  it('returns error for missing goal in both mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'both' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.goal).toBeDefined();
  });

  it('does not require goal in technical mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'technical', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    // goal is not required in technical mode, but other fields may still fail
    expect(result.errors.goal).toBeUndefined();
  });

  it('returns error for missing capital when trading', () => {
    const result = validateCreateAgentForm(
      validIntent({ capital: '', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.capital).toBeDefined();
  });

  it('returns error for non-numeric capital', () => {
    const result = validateCreateAgentForm(
      validIntent({ capital: 'abc', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.capital).toBeDefined();
  });

  it('returns error for zero capital', () => {
    const result = validateCreateAgentForm(
      validIntent({ capital: '0', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.capital).toBeDefined();
  });

  it('returns error for negative capital', () => {
    const result = validateCreateAgentForm(
      validIntent({ capital: '-100', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.capital).toBeDefined();
  });

  it('returns error for tickIntervalMins < 1', () => {
    const result = validateCreateAgentForm(
      validIntent({ tickIntervalMins: '0' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.tickIntervalMins).toBeDefined();
  });

  it('returns error for fractional tickIntervalMins', () => {
    const result = validateCreateAgentForm(
      validIntent({ tickIntervalMins: '1.5' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.tickIntervalMins).toBeDefined();
  });

  it('returns error for maxOpenPositions > constraint', () => {
    const result = validateCreateAgentForm(
      validIntent({ maxOpenPositions: '15' }),
      { ...DEFAULT_CONSTRAINTS, maxOpenPositions: 10 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.maxOpenPositions).toBeDefined();
  });

  it('returns error for maxPositionSizePct > constraint', () => {
    const result = validateCreateAgentForm(
      validIntent({ maxPositionSizePct: '80' }),
      { ...DEFAULT_CONSTRAINTS, maxPositionSizePct: 50 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.maxPositionSizePct).toBeDefined();
  });

  it('returns error for stopLossPct > constraint', () => {
    const result = validateCreateAgentForm(
      validIntent({ stopLossPct: '60' }),
      { ...DEFAULT_CONSTRAINTS, stopLossMaxUnrealizedLossPct: 30 },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.stopLossPct).toBeDefined();
  });

  it('returns error for missing venue in live mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', executionMode: 'live' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.venue).toBeDefined();
  });

  it('returns error for missing venue in shadow mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', executionMode: 'shadow' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.venue).toBeDefined();
  });

  it('does not require venue in paper mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', venueType: '', executionMode: 'paper' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors.venue).toBeUndefined();
  });

  it('returns error for paper mode with swap venue', () => {
    const result = validateCreateAgentForm(
      validIntent({ executionMode: 'paper', venueType: 'swap' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.executionMode).toBeDefined();
  });

  it('allows shadow mode with swap venue', () => {
    const result = validateCreateAgentForm(
      validIntent({ executionMode: 'shadow', venue: 'jupiter', venueType: 'swap' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.errors.executionMode).toBeUndefined();
  });

  it('allows live mode with swap venue', () => {
    const result = validateCreateAgentForm(
      validIntent({ executionMode: 'live', venue: 'jupiter', venueType: 'swap' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.errors.executionMode).toBeUndefined();
  });

  it('returns multiple errors when multiple fields are invalid', () => {
    const result = validateCreateAgentForm(
      validIntent({ name: '', goal: '', capital: 'abc' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
    expect(result.errors.goal).toBeDefined();
    expect(result.errors.capital).toBeDefined();
  });
});
