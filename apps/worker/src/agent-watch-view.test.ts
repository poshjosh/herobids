import { describe, it, expect } from 'vitest';
import {
  parseBoundaryWatchList,
  deriveActiveWatchSummaryFrom,
} from './agent-watch-view.js';

/** Build a well-formed WatchEntry object (the shape list_watches returns). */
function makeWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    watchId: '00000000-0000-4000-8000-000000000001',
    symbol: 'SOL',
    chain: 'solana',
    thresholdPrice: 200,
    condition: 'above',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastConditionMet: null,
    schemaVersion: 2,
    purpose: 'alert',
    ...overrides,
  };
}

describe('parseBoundaryWatchList', () => {
  it('parses a well-formed boundary payload into runtime active watches', () => {
    const data = {
      watches: [
        makeWatch({ watchId: '00000000-0000-4000-8000-000000000001', symbol: 'SOL' }),
        makeWatch({ watchId: '00000000-0000-4000-8000-000000000002', symbol: 'BTC', chain: 'hyperliquid' }),
      ],
    };

    const result = parseBoundaryWatchList(data);

    expect(result).toHaveLength(2);
    expect(result.map((w) => w.symbol)).toEqual(['SOL', 'BTC']);
  });

  it('drops malformed entries that fail to parse', () => {
    const data = {
      watches: [
        makeWatch({ watchId: '00000000-0000-4000-8000-000000000001', symbol: 'SOL' }),
        { not: 'a valid watch' }, // parseWatch → null, dropped
        null,                     // dropped
        makeWatch({ watchId: '00000000-0000-4000-8000-000000000003', symbol: 'ETH', chain: 'ethereum' }),
      ],
    };

    const result = parseBoundaryWatchList(data);

    // Only the two well-formed entries survive.
    expect(result).toHaveLength(2);
    expect(result.map((w) => w.symbol)).toEqual(['SOL', 'ETH']);
  });

  it('returns an empty list when watches is absent', () => {
    expect(parseBoundaryWatchList({})).toEqual([]);
    expect(parseBoundaryWatchList({ watches: undefined })).toEqual([]);
  });

  it('returns an empty list when watches is not an array', () => {
    expect(parseBoundaryWatchList({ watches: 'nope' })).toEqual([]);
    expect(parseBoundaryWatchList({ watches: 42 })).toEqual([]);
  });

  it('returns an empty list for non-object / nullish payloads', () => {
    expect(parseBoundaryWatchList(null)).toEqual([]);
    expect(parseBoundaryWatchList(undefined)).toEqual([]);
    expect(parseBoundaryWatchList('string')).toEqual([]);
    expect(parseBoundaryWatchList(123)).toEqual([]);
  });
});

describe('deriveActiveWatchSummaryFrom', () => {
  it('returns a stable EMPTY summary (not null) for an empty list', () => {
    const summary = deriveActiveWatchSummaryFrom([]);

    expect(summary).toEqual({ totalCount: 0, uniqueCount: 0, lines: [], overflowCount: 0 });
  });

  it('summarizes a non-empty watch list', () => {
    const watches = parseBoundaryWatchList({
      watches: [
        makeWatch({ watchId: '00000000-0000-4000-8000-000000000001', symbol: 'SOL' }),
      ],
    });

    const summary = deriveActiveWatchSummaryFrom(watches);

    expect(summary.totalCount).toBeGreaterThan(0);
    expect(Array.isArray(summary.lines)).toBe(true);
    expect(summary.lines.length).toBeGreaterThan(0);
  });

  it('composes with parseBoundaryWatchList: malformed-only payload → empty stable summary', () => {
    const watches = parseBoundaryWatchList({ watches: [{ garbage: true }, null] });

    expect(watches).toEqual([]);
    expect(deriveActiveWatchSummaryFrom(watches)).toEqual({
      totalCount: 0,
      uniqueCount: 0,
      lines: [],
      overflowCount: 0,
    });
  });
});
