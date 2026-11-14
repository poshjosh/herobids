import { describe, expect, it } from 'vitest';
import {
  nodesBarColor,
  nodesUsedPct,
  NODES_DANGER_PCT,
  NODES_WARNING_PCT,
} from './capacity-display.js';

describe('nodesUsedPct', () => {
  it('is the percent of the ceiling in use', () => {
    expect(nodesUsedPct(2, 5)).toBe(40);
  });

  it('caps at 100 when ready exceeds max', () => {
    expect(nodesUsedPct(7, 5)).toBe(100);
  });

  it('is zero when no ceiling is configured (avoids divide-by-zero)', () => {
    expect(nodesUsedPct(3, 0)).toBe(0);
  });
});

describe('nodesBarColor', () => {
  it('is success well below the warning line', () => {
    expect(nodesBarColor(1, 5)).toBe('var(--color-success)'); // 20%
  });

  it('is warning at or above the warning threshold', () => {
    expect(nodesBarColor(4, 5)).toBe('var(--color-warning)'); // 80%
    expect(NODES_WARNING_PCT).toBe(80);
  });

  it('is danger at or above the ceiling', () => {
    expect(nodesBarColor(5, 5)).toBe('var(--color-danger)'); // 100%
    expect(nodesBarColor(6, 5)).toBe('var(--color-danger)'); // capped 100%
    expect(NODES_DANGER_PCT).toBe(100);
  });
});
