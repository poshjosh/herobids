import { describe, expect, it } from 'vitest';
import { AGENT_STYLE_RUNTIME_DEFAULTS, RUNTIME_POLICY_CEILINGS } from './schema.js';
import {
  deriveStyleMaxHoldDurationMs,
  resolveEffectiveTickIntervalMs,
  resolveStyleTradingTickIntervalMs,
  resolveTradingTickIntervalMs,
} from './agent-schedule.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NON_TRADING_DEFAULT_MS = 24 * HOUR;

describe('resolveStyleTradingTickIntervalMs', () => {
  it('uses 90, 30 and 10 minutes for careful, balanced and bold', () => {
    expect(resolveStyleTradingTickIntervalMs('careful')).toBe(90 * MINUTE);
    expect(resolveStyleTradingTickIntervalMs('balanced')).toBe(30 * MINUTE);
    expect(resolveStyleTradingTickIntervalMs('bold')).toBe(10 * MINUTE);
  });
});

describe('deriveStyleMaxHoldDurationMs', () => {
  it('keeps the style default when the tick is the style default', () => {
    // careful tick default is 90 min; passing it back yields the careful max-hold default.
    expect(deriveStyleMaxHoldDurationMs('careful', 90 * MINUTE)).toBe(AGENT_STYLE_RUNTIME_DEFAULTS.careful.maxHoldDurationMs);
    expect(deriveStyleMaxHoldDurationMs('balanced', 30 * MINUTE)).toBe(AGENT_STYLE_RUNTIME_DEFAULTS.balanced.maxHoldDurationMs);
  });

  it('scales max hold with the tick for the same style', () => {
    // bold max-hold == tick (1× multiplier): max hold tracks the tick 1:1.
    expect(deriveStyleMaxHoldDurationMs('bold', HOUR)).toBe(HOUR);
    // balanced max-hold is 3× its tick (90 min = 3 × 30 min): scales 3× with the tick.
    expect(deriveStyleMaxHoldDurationMs('balanced', 30 * MINUTE)).toBe(3 * 30 * MINUTE);
    expect(deriveStyleMaxHoldDurationMs('balanced', HOUR)).toBe(3 * HOUR);
    // careful max-hold is 5× its tick (450 min = 5 × 90 min).
    expect(deriveStyleMaxHoldDurationMs('careful', 90 * MINUTE)).toBe(5 * 90 * MINUTE);
  });

  it('never exceeds the operator max-hold ceiling', () => {
    expect(deriveStyleMaxHoldDurationMs('careful', NON_TRADING_DEFAULT_MS)).toBe(RUNTIME_POLICY_CEILINGS.maxHoldDurationMs);
  });
});

describe('resolveTradingTickIntervalMs', () => {
  it('replaces the non-trading 24 hour default with the style trading tick', () => {
    expect(resolveTradingTickIntervalMs({
      style: 'balanced',
      currentTickIntervalMs: NON_TRADING_DEFAULT_MS,
      nonTradingDefaultTickIntervalMs: NON_TRADING_DEFAULT_MS,
    })).toBe(30 * MINUTE);
  });

  it('replaces a missing stored tick with the style trading tick', () => {
    expect(resolveTradingTickIntervalMs({
      style: 'bold',
      currentTickIntervalMs: null,
      nonTradingDefaultTickIntervalMs: NON_TRADING_DEFAULT_MS,
    })).toBe(10 * MINUTE);
  });

  it('keeps a stored tick that is not the non-trading default', () => {
    expect(resolveTradingTickIntervalMs({
      style: 'balanced',
      currentTickIntervalMs: 2 * HOUR,
      nonTradingDefaultTickIntervalMs: NON_TRADING_DEFAULT_MS,
    })).toBe(2 * HOUR);
  });
});

describe('resolveEffectiveTickIntervalMs', () => {
  it.each([true, false])('treats a stored tick as the user choice (hasTradingCapability=%s)', (hasTradingCapability) => {
    expect(resolveEffectiveTickIntervalMs({
      storedTickIntervalMs: 45 * MINUTE,
      hasTradingCapability,
      nonTradingDefaultTickIntervalMs: 6 * HOUR,
    })).toEqual({ tickIntervalMs: 45 * MINUTE, source: 'user' });
  });

  it('keeps a stored tick equal to the non-trading default as a user choice', () => {
    expect(resolveEffectiveTickIntervalMs({
      storedTickIntervalMs: NON_TRADING_DEFAULT_MS,
      hasTradingCapability: false,
      nonTradingDefaultTickIntervalMs: NON_TRADING_DEFAULT_MS,
    })).toEqual({ tickIntervalMs: NON_TRADING_DEFAULT_MS, source: 'user' });
  });

  it.each([6 * HOUR, 12 * HOUR, 90 * MINUTE])('uses the passed-in non-trading default %i for an unset non-trading agent', (nonTradingDefaultTickIntervalMs) => {
    expect(resolveEffectiveTickIntervalMs({
      storedTickIntervalMs: null,
      hasTradingCapability: false,
      nonTradingDefaultTickIntervalMs,
    })).toEqual({ tickIntervalMs: nonTradingDefaultTickIntervalMs, source: 'non_trading_default' });
  });

  it('leaves an unset trading agent unset so the style cadence applies', () => {
    expect(resolveEffectiveTickIntervalMs({
      storedTickIntervalMs: null,
      hasTradingCapability: true,
      nonTradingDefaultTickIntervalMs: 6 * HOUR,
    })).toEqual({ tickIntervalMs: null, source: 'unset' });
  });
});
