import { describe, expect, it } from 'vitest';
import { generateAgentName } from './agent-name.js';

describe('generateAgentName', () => {
  it('produces output matching {style}-agent-{4 hex chars} format', () => {
    const name = generateAgentName('balanced');
    expect(name).toMatch(/^balanced-agent-[0-9A-F]{4}$/);
  });

  it('each style produces the correct prefix', () => {
    const styles = ['careful', 'balanced', 'bold'] as const;
    for (const style of styles) {
      const name = generateAgentName(style);
      expect(name).toMatch(new RegExp(`^${style}-agent-[0-9A-F]{4}$`));
    }
  });

  it('consecutive calls produce different values (with high probability)', () => {
    const names = Array.from({ length: 10 }, () => generateAgentName('balanced'));
    const unique = new Set(names);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('does not accept a counter parameter', () => {
    expect(generateAgentName.length).toBe(1);
  });
});
