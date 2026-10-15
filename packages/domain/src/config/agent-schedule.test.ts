import { describe, expect, it } from 'vitest';
import { AGENT_STYLE_RUNTIME_DEFAULTS, RUNTIME_POLICY_CEILINGS } from './schema.js';
import {
  deriveStyleMaxHoldDurationMs,
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
    expect(deriveStyleMaxHoldDurationMs('balanced', 30 * MINUTE)).toBe(AGENT_STYLE_RUNTIME_DEFAULTS.balanced.maxHoldDurationMs);
  });

  it('scales max hold with the tick for the same style', () => {
    expect(deriveStyleMaxHoldDurationMs('balanced', HOUR)).toBe(3 * HOUR);
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
