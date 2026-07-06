import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LastFillMarkSource, MarkSelector, createFillFirstMarkSource } from './mark-source.js';
import type { FillLookup } from './mark-source.js';
import type { MarkSource, Mark, MarkError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, price } from '@herobids/domain';

// --- LastFillMarkSource ---

function makeFillLookup(result: { price: string; filledAt: string } | null): FillLookup {
  return {
    getLatestFillByInstrument: vi.fn().mockResolvedValue(result),
  };
}

describe('LastFillMarkSource', () => {
  it('returns mark from latest fill', async () => {
    const lookup = makeFillLookup({ price: '67000.50', filledAt: '2026-05-24T10:00:00Z' });
    const source = new LastFillMarkSource(lookup);

    const result = await source.fetchMark('BTC/USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.price.toString()).toBe('67000.5');
      expect(result.data.source).toBe('last_fill');
      expect(result.data.instrument).toBe('BTC/USD');
      expect(result.data.timestamp).toBe('2026-05-24T10:00:00Z');
    }
  });

  it('returns error when no fill exists', async () => {
    const lookup = makeFillLookup(null);
    const source = new LastFillMarkSource(lookup);

    const result = await source.fetchMark('ETH/USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.no_fill');
      expect(result.error.message).toContain('ETH/USD');
    }
  });

  it('passes instrument to lookup correctly', async () => {
    const lookup = makeFillLookup(null);
    const source = new LastFillMarkSource(lookup);

    await source.fetchMark('SOL/USDC');

    expect(lookup.getLatestFillByInstrument).toHaveBeenCalledWith('SOL/USDC', undefined);
  });
});

// --- MarkSelector ---

function makeStubMarkSource(result: Result<Mark, MarkError>): MarkSource {
  return { fetchMark: vi.fn().mockResolvedValue(result) };
}

function recentMark(minutesAgo: number): Result<Mark, MarkError> {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return ok({
    price: price('50000'),
    source: 'last_fill',
    instrument: 'BTC/USD',
    timestamp: ts,
  });
}

function oracleMark(): Result<Mark, MarkError> {
  return ok({
    price: price('49500'),
    source: 'oracle',
    instrument: 'BTC/USD',
    timestamp: new Date().toISOString(),
  });
}

describe('MarkSelector', () => {
  const STALENESS_5_MIN = { stalenessThresholdMs: 5 * 60_000 };

  it('returns fresh fill mark without calling fallback', async () => {
    const fillSource = makeStubMarkSource(recentMark(1)); // 1 min old
    const fallback = makeStubMarkSource(oracleMark());

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('last_fill');
      expect(result.data.price.toString()).toBe('50000');
    }
    expect(fallback.fetchMark).not.toHaveBeenCalled();
  });

  it('falls back to oracle when fill is stale', async () => {
    const fillSource = makeStubMarkSource(recentMark(10)); // 10 min old, threshold is 5 min
    const fallback = makeStubMarkSource(oracleMark());

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
      expect(result.data.price.toString()).toBe('49500');
    }
    expect(fallback.fetchMark).toHaveBeenCalledWith('BTC/USD');
  });

  it('falls back to oracle when no fill exists', async () => {
    const fillSource = makeStubMarkSource(err({ code: 'mark.no_fill', message: 'none' }));
    const fallback = makeStubMarkSource(oracleMark());

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
    }
  });

  it('returns stale fill when oracle also fails', async () => {
    const fillSource = makeStubMarkSource(recentMark(10)); // stale
    const fallback = makeStubMarkSource(err({ code: 'mark.oracle_error', message: 'timeout' }));

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('last_fill');
    }
  });

  it('returns error when both sources fail', async () => {
    const fillSource = makeStubMarkSource(err({ code: 'mark.no_fill', message: 'no fill' }));
    const fallback = makeStubMarkSource(err({ code: 'mark.oracle_error', message: 'network' }));

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('mark.unavailable');
      expect(result.error.message).toContain('no fill');
      expect(result.error.message).toContain('network');
    }
  });

  it('treats fill exactly at threshold boundary as stale', async () => {
    // A fill exactly at the threshold age should be considered stale (< not <=)
    const fillSource = makeStubMarkSource(recentMark(5)); // exactly 5 min = threshold
    const fallback = makeStubMarkSource(oracleMark());

    const selector = new MarkSelector(STALENESS_5_MIN, fillSource, fallback);
    const result = await selector.fetchMark('BTC/USD');

    // Age == threshold → fillAge >= threshold → stale → use oracle
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
    }
  });
});

// --- createFillFirstMarkSource ---

describe('createFillFirstMarkSource', () => {
  const STALENESS_5_MIN = 5 * 60_000;

  it('returns a MarkSelector that prefers a recent fill over the fallback', async () => {
    const lookup = makeFillLookup({ price: '67000.50', filledAt: new Date(Date.now() - 60_000).toISOString() }); // 1 min old
    const fallback = makeStubMarkSource(oracleMark());

    const source = createFillFirstMarkSource({
      fillLookup: lookup,
      actorId: 'agent-1',
      fallbackSource: fallback,
      stalenessThresholdMs: STALENESS_5_MIN,
    });

    const result = await source.fetchMark('BTC/USD');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('last_fill');
      expect(result.data.price.toString()).toBe('67000.5');
    }
    expect(fallback.fetchMark).not.toHaveBeenCalled();
    expect(lookup.getLatestFillByInstrument).toHaveBeenCalledWith('BTC/USD', 'agent-1');
  });

  it('returns a MarkSelector that falls back to the fallback source when no fill exists', async () => {
    const lookup = makeFillLookup(null);
    const fallback = makeStubMarkSource(oracleMark());

    const source = createFillFirstMarkSource({
      fillLookup: lookup,
      fallbackSource: fallback,
      stalenessThresholdMs: STALENESS_5_MIN,
    });

    const result = await source.fetchMark('ETH/USD');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
      expect(result.data.price.toString()).toBe('49500');
    }
    expect(fallback.fetchMark).toHaveBeenCalledWith('ETH/USD');
  });

  it('returns a MarkSelector that falls back when the fill is older than the threshold', async () => {
    const oldFill = { price: '67000.50', filledAt: new Date(Date.now() - 10 * 60_000).toISOString() }; // 10 min old
    const lookup = makeFillLookup(oldFill);
    const fallback = makeStubMarkSource(oracleMark());

    const source = createFillFirstMarkSource({
      fillLookup: lookup,
      fallbackSource: fallback,
      stalenessThresholdMs: STALENESS_5_MIN,
    });

    const result = await source.fetchMark('BTC/USD');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.source).toBe('oracle');
    }
    expect(fallback.fetchMark).toHaveBeenCalledWith('BTC/USD');
  });
});
