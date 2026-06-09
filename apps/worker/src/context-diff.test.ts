import { describe, expect, it } from 'vitest';
import { buildIncrementalContext, estimateTokens } from './context-diff.js';

describe('buildIncrementalContext', () => {
  it('uses full context on the first tick', () => {
    const result = buildIncrementalContext({
      previousContext: null,
      currentContext: '## Session Progress\nEverything is new.',
      tickNumber: 1,
    });

    expect(result.mode).toBe('full');
  });

  it('uses diff mode for small updates between ticks', () => {
    const result = buildIncrementalContext({
      previousContext: '## Session Progress\nPrice: 100\nPnL: 0',
      currentContext: '## Session Progress\nPrice: 101\nPnL: 0',
      tickNumber: 2,
    });

    expect(result.mode).toBe('diff');
    expect(result.content).toContain('- Price: 100');
    expect(result.content).toContain('+ Price: 101');
  });

  it('falls back to full context when a section disappears', () => {
    const result = buildIncrementalContext({
      previousContext: '## Session Progress\n## Venue Intelligence\n- stale line',
      currentContext: '## Session Progress',
      tickNumber: 2,
    });

    expect(result.mode).toBe('full');
    expect(result.content).toBe('## Session Progress');
  });

  it('forces full context every tenth tick', () => {
    const result = buildIncrementalContext({
      previousContext: 'old',
      currentContext: 'new',
      tickNumber: 10,
    });

    expect(result.mode).toBe('full');
  });
});

describe('estimateTokens', () => {
  it('roughly estimates token count from character length', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});