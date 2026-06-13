import { describe, expect, it } from 'vitest';
import { buildToolResultMetadata } from './tool-result-metadata.js';

describe('buildToolResultMetadata', () => {
  it('returns open-position metadata for list_positions results with positions', () => {
    const metadata = buildToolResultMetadata('list_positions', {
      ok: true,
      positions: [
        { instrumentId: 'BTC', side: 'long' },
        { instrumentId: 'ETH', side: 'long' },
      ],
    });

    expect(metadata).toEqual({
      positionCount: 2,
      hasOpenPositions: true,
    });
  });

  it('returns flat metadata for list_positions results with no positions', () => {
    const metadata = buildToolResultMetadata('list_positions', {
      ok: true,
      positions: [],
    });

    expect(metadata).toEqual({
      positionCount: 0,
      hasOpenPositions: false,
    });
  });

  it('returns undefined for non-list_positions tools or malformed results', () => {
    expect(buildToolResultMetadata('get_analytics', { positions: [{}] })).toBeUndefined();
    expect(buildToolResultMetadata('list_positions', { ok: true })).toBeUndefined();
    expect(buildToolResultMetadata('list_positions', null)).toBeUndefined();
  });
});