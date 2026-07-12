import { describe, it, expect } from 'vitest';
import { parseWatch, toRuntimeActiveWatch, type WatchEntry, type WatchInstrumentIdentity } from './watch-types.js';

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
    purpose: 'alert',
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

  it('rejects a record without schemaVersion (only structured watches supported)', () => {
    const raw = JSON.stringify(validLegacyRecord());
    const result = parseWatch(raw);
    expect(result).toBeNull();
  });

  it('rejects a minimal record without schemaVersion (only structured watches supported)', () => {
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
    expect(result).toBeNull();
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

  // -------------------------------------------------------------------
  // Instrument identity
  // -------------------------------------------------------------------

  it('parses a valid v2 record with instrument identity', () => {
    const raw = JSON.stringify(validV2Record({
      instrument: {
        venue: 'hyperliquid',
        instrumentId: 'BTC-USD',
        symbol: 'BTC',
        chain: 'hyperliquid',
      },
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.instrument).toEqual({
      venue: 'hyperliquid',
      instrumentId: 'BTC-USD',
      symbol: 'BTC',
      chain: 'hyperliquid',
    });
  });

  it('parses instrument identity with optional address', () => {
    const raw = JSON.stringify(validV2Record({
      instrument: {
        venue: 'hyperliquid',
        instrumentId: 'ETH-USD',
        symbol: 'ETH',
        chain: 'ethereum',
        address: '0xabc123',
      },
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.instrument).toEqual({
      venue: 'hyperliquid',
      instrumentId: 'ETH-USD',
      symbol: 'ETH',
      chain: 'ethereum',
      address: '0xabc123',
    });
  });

  it('parses instrument identity without optional chain and address', () => {
    const raw = JSON.stringify(validV2Record({
      instrument: {
        venue: 'hyperliquid',
        instrumentId: 'SOL-USD',
        symbol: 'SOL',
      },
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.instrument).toEqual({
      venue: 'hyperliquid',
      instrumentId: 'SOL-USD',
      symbol: 'SOL',
    });
    expect(result!.instrument!.chain).toBeUndefined();
    expect(result!.instrument!.address).toBeUndefined();
  });

  it('rejects legacy record without instrument field (no schemaVersion)', () => {
    const raw = JSON.stringify(validLegacyRecord());
    const result = parseWatch(raw);
    expect(result).toBeNull();
  });

  it('returns null when instrument.venue is empty', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { venue: '', instrumentId: 'BTC-USD', symbol: 'BTC' },
    })))).toBeNull();
  });

  it('returns null when instrument.instrumentId is empty', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { venue: 'hyperliquid', instrumentId: '', symbol: 'BTC' },
    })))).toBeNull();
  });

  it('returns null when instrument.symbol is empty', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { venue: 'hyperliquid', instrumentId: 'BTC-USD', symbol: '' },
    })))).toBeNull();
  });

  it('returns null when instrument is missing required venue', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { instrumentId: 'BTC-USD', symbol: 'BTC' },
    })))).toBeNull();
  });

  it('returns null when instrument is missing required instrumentId', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { venue: 'hyperliquid', symbol: 'BTC' },
    })))).toBeNull();
  });

  it('returns null when instrument is not an object', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ instrument: 'not-an-object' })))).toBeNull();
  });

  it('returns null when instrument.chain is not a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      instrument: { venue: 'hl', instrumentId: 'BTC', symbol: 'BTC', chain: 123 },
    })))).toBeNull();
  });

  // -------------------------------------------------------------------
  // Purpose
  // -------------------------------------------------------------------

  it.each([
    'entry',
    'exit',
    'stop_loss',
    'take_profit',
    'monitor',
    'alert',
  ] as const)('parses a valid v2 record with purpose "%s"', (purpose) => {
    const raw = JSON.stringify(validV2Record({ purpose }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.purpose).toBe(purpose);
  });

  it('returns null when purpose is an invalid value', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ purpose: 'invalid' })))).toBeNull();
  });

  it('returns null when purpose is not a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ purpose: 123 })))).toBeNull();
  });

  it('returns null when purpose is an empty string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ purpose: '' })))).toBeNull();
  });

  it('returns null when purpose field is missing', () => {
    const { purpose: _, ...withoutPurpose } = validV2Record();
    const raw = JSON.stringify(withoutPurpose);
    const result = parseWatch(raw);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------

  it('parses a valid v2 record with full coverage link', () => {
    const raw = JSON.stringify(validV2Record({
      coverage: {
        actorType: 'agent',
        actorId: 'agent-1',
        positionKey: 'BTC-USD-long',
        intentGroup: 'momentum-entry',
      },
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.coverage).toEqual({
      actorType: 'agent',
      actorId: 'agent-1',
      positionKey: 'BTC-USD-long',
      intentGroup: 'momentum-entry',
    });
  });

  it('parses a record with partial coverage link (only positionKey)', () => {
    const raw = JSON.stringify(validV2Record({
      coverage: { positionKey: 'SOL-USD-short' },
    }));
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.coverage).toEqual({ positionKey: 'SOL-USD-short' });
  });

  it('parses a record without coverage field', () => {
    const raw = JSON.stringify(validV2Record());
    const result = parseWatch(raw);
    expect(result).not.toBeNull();
    expect(result!.coverage).toBeUndefined();
  });

  it('returns null when coverage.actorType is invalid', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      coverage: { actorType: 'invalid' },
    })))).toBeNull();
  });

  it('returns null when coverage is not an object', () => {
    expect(parseWatch(JSON.stringify(validV2Record({ coverage: 'not-an-object' })))).toBeNull();
  });

  it('returns null when coverage.actorId is not a string', () => {
    expect(parseWatch(JSON.stringify(validV2Record({
      coverage: { actorId: 123 },
    })))).toBeNull();
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

  it('propagates instrument identity when present', () => {
    const instrument: WatchInstrumentIdentity = {
      venue: 'hyperliquid',
      instrumentId: 'BTC-USD',
      symbol: 'BTC',
      chain: 'hyperliquid',
    };
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'hyperliquid',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      instrument,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.instrument).toEqual(instrument);
  });

  it('propagates instrument identity with address', () => {
    const instrument: WatchInstrumentIdentity = {
      venue: 'hyperliquid',
      instrumentId: 'ETH-USD',
      symbol: 'ETH',
      chain: 'ethereum',
      address: '0xdef456',
    };
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'ETH',
      chain: 'ethereum',
      thresholdPrice: 3_000,
      condition: 'below',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: false,
      instrument,
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.instrument).toEqual(instrument);
  });

  it('omits instrument from runtime when not present', () => {
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
    expect(runtime.instrument).toBeUndefined();
    expect(Object.hasOwn(runtime, 'instrument')).toBe(false);
  });

  it('propagates purpose when present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      purpose: 'entry',
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.purpose).toBe('entry');
  });

  it('omits purpose from runtime when not present', () => {
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
    expect(runtime.purpose).toBeUndefined();
    expect(Object.hasOwn(runtime, 'purpose')).toBe(false);
  });

  it('propagates coverage when present', () => {
    const watch: WatchEntry = {
      watchId: VALID_UUID,
      symbol: 'BTC',
      chain: 'ethereum',
      thresholdPrice: 50_000,
      condition: 'above',
      createdAt: '2026-07-01T00:00:00.000Z',
      lastConditionMet: null,
      coverage: { positionKey: 'BTC-USD-long', actorType: 'agent' },
    };
    const runtime = toRuntimeActiveWatch(watch);
    expect(runtime.coverage).toEqual({ positionKey: 'BTC-USD-long', actorType: 'agent' });
  });

  it('omits coverage from runtime when not present', () => {
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
    expect(runtime.coverage).toBeUndefined();
    expect(Object.hasOwn(runtime, 'coverage')).toBe(false);
  });
});
