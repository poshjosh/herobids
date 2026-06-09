import { describe, expect, it } from 'vitest';
import { buildIncrementalContext, estimateTokens } from './context-diff.js';

const DEFAULTS = { fullContextEveryTicks: 10, maxDiffTokens: 200, maxChangedLines: 12 };

describe('buildIncrementalContext', () => {
  it('uses full context on the first tick', () => {
    const result = buildIncrementalContext({
      previousContext: null,
      currentContext: '## Session Progress\nEverything is new.',
      tickNumber: 1,
      ...DEFAULTS,
    });

    expect(result.mode).toBe('full');
  });

  it('uses diff mode for small updates between ticks', () => {
    const result = buildIncrementalContext({
      previousContext: '## Session Progress\nPrice: 100\nPnL: 0',
      currentContext: '## Session Progress\nPrice: 101\nPnL: 0',
      tickNumber: 2,
      ...DEFAULTS,
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
      ...DEFAULTS,
    });

    expect(result.mode).toBe('full');
    expect(result.content).toBe('## Session Progress');
  });

  it('forces full context every tenth tick', () => {
    const result = buildIncrementalContext({
      previousContext: 'old',
      currentContext: 'new',
      tickNumber: 10,
      ...DEFAULTS,
    });

    expect(result.mode).toBe('full');
  });

  describe('fullContextEveryTicks parameter', () => {
    it('respects a custom fullContextEveryTicks interval', () => {
      const result = buildIncrementalContext({
        previousContext: 'old context',
        currentContext: 'new context',
        tickNumber: 5,
        ...DEFAULTS,
        fullContextEveryTicks: 5,
      });

      expect(result.mode).toBe('full');
    });

    it('does not force full context before the custom interval', () => {
      const result = buildIncrementalContext({
        previousContext: '## Section\nline A',
        currentContext: '## Section\nline B',
        tickNumber: 5,
        ...DEFAULTS,
        fullContextEveryTicks: 20,
      });

      expect(result.mode).toBe('diff');
    });

    it('forces full context at the configured interval', () => {
      const atDefault = buildIncrementalContext({
        previousContext: '## Section\nline A',
        currentContext: '## Section\nline B',
        tickNumber: 10,
        ...DEFAULTS,
      });
      const beforeDefault = buildIncrementalContext({
        previousContext: '## Section\nline A',
        currentContext: '## Section\nline B',
        tickNumber: 9,
        ...DEFAULTS,
      });

      expect(atDefault.mode).toBe('full');
      expect(beforeDefault.mode).toBe('diff');
    });
  });

  describe('maxDiffTokens parameter', () => {
    it('falls back to full context when diff exceeds custom token limit', () => {
      const previous = '## Section\n' + 'old line\n'.repeat(5);
      const current = '## Section\n' + 'new line\n'.repeat(5);

      const resultTight = buildIncrementalContext({
        previousContext: previous,
        currentContext: current,
        tickNumber: 2,
        ...DEFAULTS,
        maxDiffTokens: 1, // force fallback
      });
      const resultLoose = buildIncrementalContext({
        previousContext: previous,
        currentContext: current,
        tickNumber: 2,
        ...DEFAULTS,
        maxDiffTokens: 10_000, // never fallback
      });

      expect(resultTight.mode).toBe('full');
      expect(resultLoose.mode).toBe('diff');
    });
  });

  describe('maxChangedLines parameter', () => {
    it('truncates diff at the custom maxChangedLines limit', () => {
      const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
      const manyLinesChanged = Array.from({ length: 20 }, (_, i) => `changed-${i}`).join('\n');

      const resultSmallLimit = buildIncrementalContext({
        previousContext: '## Section\n' + manyLines,
        currentContext: '## Section\n' + manyLinesChanged,
        tickNumber: 2,
        ...DEFAULTS,
        maxChangedLines: 2,
        maxDiffTokens: 10_000,
      });

      expect(resultSmallLimit.mode).toBe('diff');
      expect(resultSmallLimit.content).toContain('- line-0');
      expect(resultSmallLimit.content).toContain('+ changed-0');
      expect(resultSmallLimit.content).not.toContain('- line-1');
      expect(resultSmallLimit.content).not.toContain('+ changed-1');
    });

    it('captures six changed source lines at maxChangedLines=12', () => {
      const lines12 = Array.from({ length: 12 }, (_, i) => `A${i}: value`).join('\n');
      const lines12changed = Array.from({ length: 12 }, (_, i) => `A${i}: changed`).join('\n');

      const result = buildIncrementalContext({
        previousContext: '## Section\n' + lines12,
        currentContext: '## Section\n' + lines12changed,
        tickNumber: 2,
        ...DEFAULTS,
        maxDiffTokens: 10_000,
      });

      expect(result.mode).toBe('diff');
      expect(result.content).toContain('- A0: value');
      expect(result.content).toContain('+ A5: changed');
      expect(result.content).not.toContain('- A6: value');
      expect(result.content).not.toContain('+ A6: changed');
    });
  });
});

describe('estimateTokens', () => {
  it('roughly estimates token count from character length', () => {
    expect(estimateTokens('12345678')).toBe(2);
  });
});