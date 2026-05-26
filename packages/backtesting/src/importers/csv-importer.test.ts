import { describe, it, expect } from 'vitest';
import { parseCsvToFrames } from './csv-importer.js';

describe('parseCsvToFrames', () => {
  it('parses ISO 8601 timestamps and prices', () => {
    const csv = [
      'timestamp,price,volume',
      '2026-01-01T00:00:00.000Z,50000,100',
      '2026-01-01T00:01:00.000Z,50100,150',
      '2026-01-01T00:02:00.000Z,50050,120',
    ].join('\n');

    const frames = parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1, volume: 2 },
      skipRows: 1,
    });

    expect(frames).toHaveLength(3);
    expect(frames[0]!.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(frames[0]!.price.toString()).toBe('50000');
    expect(frames[0]!.data?.['volume']).toBe('100');
    expect(frames[2]!.price.toString()).toBe('50050');
  });

  it('parses Unix millisecond timestamps', () => {
    const baseMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const csv = [
      `${baseMs},50000`,
      `${baseMs + 60000},50100`,
    ].join('\n');

    const frames = parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1 },
    });

    expect(frames).toHaveLength(2);
    expect(frames[0]!.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('parses Unix second timestamps', () => {
    const baseSec = Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000);
    const csv = [
      `${baseSec},50000`,
      `${baseSec + 60},50100`,
    ].join('\n');

    const frames = parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1 },
    });

    expect(frames).toHaveLength(2);
    expect(frames[0]!.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws on empty CSV', () => {
    expect(() => parseCsvToFrames('header\n', {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1 },
      skipRows: 1,
    })).toThrow('no data rows');
  });

  it('throws on out-of-order timestamps', () => {
    const csv = [
      '2026-01-01T00:02:00.000Z,50000',
      '2026-01-01T00:01:00.000Z,50100',
    ].join('\n');

    expect(() => parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1 },
    })).toThrow('not time-ordered');
  });

  it('throws on invalid price', () => {
    const csv = '2026-01-01T00:00:00.000Z,notanumber\n';
    expect(() => parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1 },
    })).toThrow('invalid price');
  });

  it('supports custom delimiter', () => {
    const csv = '2026-01-01T00:00:00.000Z;50000;100\n2026-01-01T00:01:00.000Z;50100;200\n';
    const frames = parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 1, volume: 2 },
      delimiter: ';',
    });
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data?.['volume']).toBe('100');
  });

  it('includes OHLC data when column mappings provided', () => {
    const csv = [
      'time,open,high,low,close,volume',
      '2026-01-01T00:00:00.000Z,49900,50200,49800,50000,500',
    ].join('\n');

    const frames = parseCsvToFrames(csv, {
      symbol: 'BTC/USD:USD',
      columns: { timestamp: 0, price: 4, open: 1, high: 2, low: 3, close: 4, volume: 5 },
      skipRows: 1,
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.price.toString()).toBe('50000');
    expect(frames[0]!.data?.['open']).toBe('49900');
    expect(frames[0]!.data?.['high']).toBe('50200');
    expect(frames[0]!.data?.['low']).toBe('49800');
    expect(frames[0]!.data?.['volume']).toBe('500');
  });
});
