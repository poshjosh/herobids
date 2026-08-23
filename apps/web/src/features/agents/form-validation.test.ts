import { describe, expect, it } from 'vitest';
import { validateCreateAgentForm, type ValidationConstraints } from './form-validation.js';

const DEFAULT_CONSTRAINTS: ValidationConstraints = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  stopLossPct: 100,
};

function validIntent(overrides: Partial<Parameters<typeof validateCreateAgentForm>[0]> = {}) {
  return {
    name: 'test-agent',
    goal: 'Trade BTC',
    capabilityMode: 'hybrid' as const,
    capital: '1000',
    tickIntervalMins: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    executionMode: 'test',
    requiresTradingSetup: true,
    hasConnection: true,
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

  it('does not return error for missing goal in intelligence mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'intelligence', requiresTradingSetup: false }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.errors.goal).toBeUndefined();
  });

  it('does not return error for missing goal in hybrid mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'hybrid' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.errors.goal).toBeUndefined();
  });

  it('does not require goal in hybrid mode even with trading setup', () => {
    const result = validateCreateAgentForm(
      validIntent({ goal: '', capabilityMode: 'hybrid', requiresTradingSetup: true }),
      DEFAULT_CONSTRAINTS,
    );
    // goal is now optional — agents created without one get a default blank prompt
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
      { ...DEFAULT_CONSTRAINTS, stopLossPct: 30 },
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

  it('does not require venue in test mode', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', executionMode: 'test' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors.venue).toBeUndefined();
  });

  it('does not require venue in test mode without venue type', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', venueType: '', executionMode: 'test' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors.venue).toBeUndefined();
  });

  it('allows test mode with swap venue (backend resolves to shadow)', () => {
    const result = validateCreateAgentForm(
      validIntent({ executionMode: 'test', venue: 'jupiter', venueType: 'swap' }),
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

  it('requires a granted connection when a venue is selected', () => {
    const result = validateCreateAgentForm(
      validIntent({ hasConnection: false }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.connectionIds).toBeDefined();
  });

  it('does not require a connection when no venue is selected', () => {
    const result = validateCreateAgentForm(
      validIntent({ venue: '', venueType: '', executionMode: 'test', hasConnection: false }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(true);
    expect(result.errors.connectionIds).toBeUndefined();
  });

  it('does not require a connection for non-trading agents even with a venue set', () => {
    const result = validateCreateAgentForm(
      validIntent({ requiresTradingSetup: false, hasConnection: false }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.errors.connectionIds).toBeUndefined();
  });

  it('returns multiple errors when multiple fields are invalid', () => {
    const result = validateCreateAgentForm(
      validIntent({ name: '', goal: '', capital: 'abc', capabilityMode: 'hybrid' }),
      DEFAULT_CONSTRAINTS,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.name).toBeDefined();
    expect(result.errors.capital).toBeDefined();
    // goal is now optional — no error expected for empty goal
    expect(result.errors.goal).toBeUndefined();
  });
});
