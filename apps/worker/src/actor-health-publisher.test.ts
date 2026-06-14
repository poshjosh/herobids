import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActorHealthPublisher } from './actor-health-publisher.js';
import type { ActorHealthSnapshot } from '@herobids/domain';
import { ACTOR_HEALTH_TTL_SECONDS } from '@herobids/domain';

function makeRedis() {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  };
}

function makeSnapshot(overrides: Partial<ActorHealthSnapshot> = {}): ActorHealthSnapshot {
  return {
    actorType: 'agent',
    actorId: 'agent-1',
    status: 'healthy',
    reasons: [],
    executionMode: 'paper',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ActorHealthPublisher', () => {
  let redis: ReturnType<typeof makeRedis>;
  let publisher: ActorHealthPublisher;

  beforeEach(() => {
    redis = makeRedis();
    publisher = new ActorHealthPublisher(redis as any);
  });

  describe('publish()', () => {
    it('writes snapshot as JSON to Redis with the correct key', async () => {
      const snapshot = makeSnapshot();
      await publisher.publish(snapshot);

      expect(redis.set).toHaveBeenCalledOnce();
      const [key, value] = redis.set.mock.calls[0] as [string, string, string, number];
      expect(key).toBe('herobids:actor-health:agent:agent-1');
      expect(JSON.parse(value)).toMatchObject({ actorId: 'agent-1', status: 'healthy' });
    });

    it('sets the TTL to ACTOR_HEALTH_TTL_SECONDS', async () => {
      await publisher.publish(makeSnapshot());

      const [, , exFlag, ttl] = redis.set.mock.calls[0] as [string, string, string, number];
      expect(exFlag).toBe('EX');
      expect(ttl).toBe(ACTOR_HEALTH_TTL_SECONDS);
    });

    it('uses the correct key for a bot', async () => {
      await publisher.publish(makeSnapshot({ actorType: 'bot', actorId: 'bot-99' }));

      const [key] = redis.set.mock.calls[0] as [string, ...unknown[]];
      expect(key).toBe('herobids:actor-health:bot:bot-99');
    });

    it('does not throw when Redis set fails', async () => {
      redis.set.mockRejectedValue(new Error('redis connection refused'));
      await expect(publisher.publish(makeSnapshot())).resolves.not.toThrow();
    });
  });

  describe('remove()', () => {
    it('deletes the key for the given actor', async () => {
      await publisher.remove('agent', 'agent-1');

      expect(redis.del).toHaveBeenCalledWith('herobids:actor-health:agent:agent-1');
    });

    it('deletes the correct key for a bot', async () => {
      await publisher.remove('bot', 'bot-42');

      expect(redis.del).toHaveBeenCalledWith('herobids:actor-health:bot:bot-42');
    });

    it('does not throw when Redis del fails', async () => {
      redis.del.mockRejectedValue(new Error('redis timeout'));
      await expect(publisher.remove('agent', 'agent-1')).resolves.not.toThrow();
    });
  });

  describe('get()', () => {
    it('returns null when no snapshot is stored', async () => {
      redis.get.mockResolvedValue(null);
      const result = await publisher.get('agent', 'agent-1');
      expect(result).toBeNull();
    });

    it('returns the deserialized snapshot when one is stored', async () => {
      const snapshot = makeSnapshot({ status: 'degraded', reasons: ['stream_disconnected'] });
      redis.get.mockResolvedValue(JSON.stringify(snapshot));

      const result = await publisher.get('agent', 'agent-1');
      expect(result).toMatchObject({ status: 'degraded', reasons: ['stream_disconnected'] });
    });

    it('reads from the correct Redis key', async () => {
      redis.get.mockResolvedValue(null);
      await publisher.get('bot', 'bot-5');
      expect(redis.get).toHaveBeenCalledWith('herobids:actor-health:bot:bot-5');
    });

    it('returns null when Redis get throws', async () => {
      redis.get.mockRejectedValue(new Error('connection error'));
      const result = await publisher.get('agent', 'agent-1');
      expect(result).toBeNull();
    });
  });
});
