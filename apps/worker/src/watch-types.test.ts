import { describe, it, expect } from 'vitest';
import { parseWatch, toRuntimeActiveWatch, isWatchEntryV2, type WatchEntry } from './watch-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_UUID = 'd0e1f2a3-b4c5-4678-9def-0a1b2c3d4e5f';

function validV2Record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    watchId: VALID_UUID,
    symbol: 'BTC',
    chain: 'ethereum',
    thresholdPrice: 50_000,
    condition: 'above',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastConditionMet: null,
    schemaVersion: 2,
    ...overrides,
  };
}

function validLegacyRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    watchId: VALID_UUID,
    symbol: 'ETH',
    chain: 'ethereum',
    thresholdPrice: 3_000,
    condition: 'below',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastConditionMet: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseWatch
// ---------------------------------------------------------------------------

describe('parseWatch', () => {
  it('parses a valid v2 watch record with all fields', () => {
    const raw = JSON.stringify(validV2Record({
      address: '0xabc',
      resolvedSymbol: 'WBTC',
      resolvedChain: 'ethereum',
      resolvedAddress: '0xdef',
      note: 'Entry trigger',
      lastCheckedAt: '2026-07-07T00:00:00.000Z',
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.watchId).toBe(VALID_UUID);
    expect(result!.symbol).toBe('BTC');
    expect(result!.chain).toBe('ethereum');
    expect(result!.address).toBe('0xabc');
    expect(result!.resolvedSymbol).toBe('WBTC');
    expect(result!.resolvedChain).toBe('ethereum');
    expect(result!.resolvedAddress).toBe('0xdef');
    expect(result!.thresholdPrice).toBe(50_000);
    expect(result!.condition).toBe('above');
    expect(result!.note).toBe('Entry trigger');
    expect(result!.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(result!.lastConditionMet).toBeNull();
    expect(result!.lastCheckedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(result!.schemaVersion).toBe(2);
  });

  it('parses a valid legacy record without schemaVersion', () => {
    const raw = JSON.stringify(validLegacyRecord());
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.watchId).toBe(VALID_UUID);
    expect(result!.symbol).toBe('ETH');
    expect(result!.chain).toBe('ethereum');
    expect(result!.thresholdPrice).toBe(3_000);
    expect(result!.condition).toBe('below');
    expect(result!.schemaVersion).toBeUndefined();
    expect(result!.lastConditionMet).toBe(false);
  });

  it('parses a minimal legacy record with only required fields', () => {
    const raw = JSON.stringify({
      watchId: VALID_UUID,
      symbol: 'SOL',
      chain: 'solana',
      thresholdPrice: 100,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
    });
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.symbol).toBe('SOL');
    expect(result!.address).toBeUndefined();
    expect(result!.note).toBeUndefined();
    expect(result!.lastCheckedAt).toBeUndefined();
    expect(result!.schemaVersion).toBeUndefined();
  });

  it('parses a record with lastConditionMet: true', () => {
    const raw = JSON.stringify(validV2Record({ lastConditionMet: true }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.lastConditionMet).toBe(true);
  });

  // -------------------------------------------------------------------
  // Malformed inputs
  // -------------------------------------------------------------------

  it('returns null for malformed JSON', () => {
    expect(parseWatch('not-json')).toBeNull();
    expect(parseWatch('{ broken }')).toBeNull();
    expect(parseWatch('')).toBeNull();
  });

  it('returns null for non-object JSON values', () => {
    expect(parseWatch('42')).toBeNull();
    expect(parseWatch('"a string"')).toBeNull();
    expect(parseWatch('true')).toBeNull();
    expect(parseWatch('null')).toBeNull();
    expect(parseWatch('[]')).toBeNull();
  });

  // -------------------------------------------------------------------
  // Missing required fields
  // -------------------------------------------------------------------

  it('returns null when watchId is missing', () => {
    const { watchId: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when symbol is missing', () => {
    const { symbol: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when chain is missing', () => {
    const { chain: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when thresholdPrice is missing', () => {
    const { thresholdPrice: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when condition is missing', () => {
    const { condition: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when createdAt is missing', () => {
    const { createdAt: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  it('returns null when lastConditionMet is missing', () => {
    const { lastConditionMet: _, ...rest } = validV2Record();
    expect(parseWatch(JSON.stringify(rest))).toBeNull();
  });

  // -------------------------------------------------------------------
  // Wrong types
  // -------------------------------------------------------------------

  it('returns null when thresholdPrice is a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ thresholdPrice: '100' })))).toBeNull();
  });

  it('returns null when thresholdPrice is a boolean', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ thresholdPrice: true })))).toBeNull();
  });

  it('returns null when lastConditionMet is a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ lastConditionMet: 'true' })))).toBeNull();
  });

  it('returns null when schemaVersion is a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ schemaVersion: '2' })))).toBeNull();
  });

  it('returns null when watchId is not a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ watchId: 123 })))).toBeNull();
  });

  it('returns null when symbol is an empty string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ symbol: '' })))).toBeNull();
  });

  it('returns null when chain is an empty string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ chain: '' })))).toBeNull();
  });

  it('returns null when createdAt is an empty string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ createdAt: '' })))).toBeNull();
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  it('returns null when thresholdPrice is 0 (rejected by .positive())', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ thresholdPrice: 0 })))).toBeNull();
  });

  it('returns null when thresholdPrice is negative', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ thresholdPrice: -100 })))).toBeNull();
  });

  it('returns null when condition is "exact" (not in enum)', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ condition: 'exact' })))).toBeNull();
  });

  it('returns null when condition is an arbitrary string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ condition: 'gte' })))).toBeNull();
  });

  it('returns null when watchId is not a valid UUID', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ watchId: 'not-a-uuid' })))).toBeNull();
  });

  it('returns null when watchId is an empty string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ watchId: '' })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toRuntimeActiveWatch
// ---------------------------------------------------------------------------

describe('toRuntimeActiveWatch', () => {
  it('propagates all core fields correctly', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      note: 'Entry trigger',
      lastCheckedAt: '2026-07-07T00:00:00.000Z',
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.watchId).toBe(VALID_UUID);
    expect(runtime.symbol).toBe('BTC');
    expect(runtime.chain).toBe('ethereum');
    expect(runtime.thresholdPrice).toBe(50_000);
    expect(runtime.condition).toBe('above');
    expect(runtime.lastConditionMet).toBeNull();
    expect(runtime.note).toBe('Entry trigger');
    expect(runtime.lastCheckedAt).toBe('2026-07-07T00:00:00.000Z');
  });

  it('propagates optional address field when present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'USDC',
      chain: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      thresholdPrice: 1,
      condition: 'below',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
  });

  it('omits address from runtime when not present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'ETH',
      chain: 'ethereum',
      thresholdPrice: 3_000,
      condition: 'below',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: false,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.address).toBeUndefined();
    expect(Object.hasOwn(runtime, 'address')).toBe(false);
  });

  it('propagates resolved identity fields when present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'PEPE',
      chain: 'ethereum',
      address: '0xabc',
      resolvedSymbol: 'PEPE',
      resolvedChain: 'ethereum',
      resolvedAddress: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      thresholdPrice: 0.00001,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: false,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.resolvedSymbol).toBe('PEPE');
    expect(runtime.resolvedChain).toBe('ethereum');
    expect(runtime.resolvedAddress).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
  });

  it('omits resolved fields from runtime when not present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(Object.hasOwn(runtime, 'resolvedSymbol')).toBe(false);
    expect(Object.hasOwn(runtime, 'resolvedChain')).toBe(false);
    expect(Object.hasOwn(runtime, 'resolvedAddress')).toBe(false);
  });

  it('propagates schemaVersion when present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      schemaVersion: 2,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.schemaVersion).toBe(2);
  });

  it('omits schemaVersion from runtime when not present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(Object.hasOwn(runtime, 'schemaVersion')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWatchEntryV2
// ---------------------------------------------------------------------------

describe('isWatchEntryV2', () => {
  it('returns false when schemaVersion is undefined', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
    };
    expect(isWatchEntryV2(watch)).toBe(false);
  });

  it('returns false when schemaVersion is 1', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      schemaVersion: 1,
    };
    expect(isWatchEntryV2(watch)).toBe(false);
  });

  it('returns true when schemaVersion is 2', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      schemaVersion: 2,
    };
    expect(isWatchEntryV2(watch)).toBe(true);
  });

  it('returns true when schemaVersion is greater than 2', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      schemaVersion: 3,
    };
    expect(isWatchEntryV2(watch)).toBe(true);
  });
});
