import { describe, it, expect } from 'vitest';
import { actorHealthKey, ACTOR_HEALTH_TTL_SECONDS } from './actor-health.js';

describe('actorHealthKey', () => {
  it('returns the correct key for an agent', () => {
    expect(actorHealthKey('agent', 'agent-123')).toBe('herobids:actor-health:agent:agent-123');
  });

  it('returns the correct key for a bot', () => {
    expect(actorHealthKey('bot', 'bot-abc')).toBe('herobids:actor-health:bot:bot-abc');
  });

  it('includes the actorId verbatim', () => {
    const id = 'some-uuid-with-dashes-0000';
    expect(actorHealthKey('agent', id)).toContain(id);
  });

  it('produces different keys for agent vs bot with the same id', () => {
    const id = 'shared-id';
    expect(actorHealthKey('agent', id)).not.toBe(actorHealthKey('bot', id));
  });
});

describe('ACTOR_HEALTH_TTL_SECONDS', () => {
  it('is a positive number', () => {
    expect(ACTOR_HEALTH_TTL_SECONDS).toBeGreaterThan(0);
  });

  it('is at least 60 seconds to allow for a reasonable heartbeat interval', () => {
    expect(ACTOR_HEALTH_TTL_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
