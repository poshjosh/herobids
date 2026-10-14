import { describe, it, expect } from 'vitest';
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS, generateAgentNameCandidate } from './agent-name.js';

describe('generateAgentNameCandidate', () => {
  it('builds a lowercase adjective-noun name from the word lists', () => {
    const name = generateAgentNameCandidate(() => 0);

    expect(name).toBe(`${AGENT_NAME_ADJECTIVES[0]}-${AGENT_NAME_NOUNS[0]}`);
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('picks the last word when the random source is near one', () => {
    const name = generateAgentNameCandidate(() => 0.999999);

    expect(name).toBe(`${AGENT_NAME_ADJECTIVES.at(-1)}-${AGENT_NAME_NOUNS.at(-1)}`);
  });

  it('keeps the word lists non-empty and free of hyphens', () => {
    expect(AGENT_NAME_ADJECTIVES.length).toBeGreaterThan(20);
    expect(AGENT_NAME_NOUNS.length).toBeGreaterThan(20);
    for (const word of [...AGENT_NAME_ADJECTIVES, ...AGENT_NAME_NOUNS]) {
      expect(word).not.toMatch(/-/);
    }
  });
});
