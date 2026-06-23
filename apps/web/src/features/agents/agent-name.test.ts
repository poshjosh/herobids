import { describe, expect, it } from 'vitest';
import { generateAgentName } from './agent-name.js';

describe('generateAgentName', () => {
  it('generates careful-agent-0 for careful style with counter 0', () => {
    expect(generateAgentName('careful', 0)).toBe('careful-agent-0');
  });

  it('increments correctly for careful style', () => {
    expect(generateAgentName('careful', 0)).toBe('careful-agent-0');
    expect(generateAgentName('careful', 1)).toBe('careful-agent-1');
    expect(generateAgentName('careful', 5)).toBe('careful-agent-5');
  });

  it('increments correctly for balanced style', () => {
    expect(generateAgentName('balanced', 0)).toBe('balanced-agent-0');
    expect(generateAgentName('balanced', 3)).toBe('balanced-agent-3');
  });

  it('increments correctly for bold style', () => {
    expect(generateAgentName('bold', 0)).toBe('bold-agent-0');
    expect(generateAgentName('bold', 10)).toBe('bold-agent-10');
  });

  it('each style produces valid prefix', () => {
    const styles = ['careful', 'balanced', 'bold'] as const;
    for (const style of styles) {
      const name = generateAgentName(style, 0);
      expect(name.startsWith(`${style}-agent-`)).toBe(true);
    }
  });
});
