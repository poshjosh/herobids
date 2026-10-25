import { describe, it, expect } from 'vitest';
import { AGENT_API_KEY_PREFIX, generateAgentApiKey, hashAgentApiKey, isAgentApiKey } from './agent-api-key.js';

describe('generateAgentApiKey', () => {
  it('returns a prefixed key whose hash is not the raw key', () => {
    const { rawKey, keyHash } = generateAgentApiKey();
    expect(rawKey.startsWith(AGENT_API_KEY_PREFIX)).toBe(true);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).not.toContain(rawKey);
    expect(keyHash).toBe(hashAgentApiKey(rawKey));
  });

  it('generates a distinct key on each call', () => {
    expect(generateAgentApiKey().rawKey).not.toBe(generateAgentApiKey().rawKey);
  });
});

describe('isAgentApiKey', () => {
  it('recognises the agent key prefix and rejects JWT-shaped tokens', () => {
    expect(isAgentApiKey(generateAgentApiKey().rawKey)).toBe(true);
    expect(isAgentApiKey('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe(false);
  });
});
