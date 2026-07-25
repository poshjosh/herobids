import { describe, it, expect, vi } from 'vitest';
import { cleanupEphemeralAgentRedisState } from './agent-ephemeral-redis-cleanup.js';

function makeRedisMock() {
  const pipelineMock = {
    del: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  return {
    pipeline: vi.fn().mockReturnValue(pipelineMock),
  } as any;
}

const AGENT_ID = 'agent-test-1';

describe('cleanupEphemeralAgentRedisState', () => {
  it('deletes exactly the 11 ephemeral keys via pipeline', async () => {
    const redis = makeRedisMock();

    await cleanupEphemeralAgentRedisState(redis, AGENT_ID);

    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    const pipeline = redis.pipeline.mock.results[0]!.value;
    expect(pipeline.del).toHaveBeenCalledTimes(11);

    const deletedKeys = pipeline.del.mock.calls.map((c: string[]) => c[0]);
    expect(deletedKeys).toContain(`agent:inbound:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:outbound:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:prompt:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:prompt:scout:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:prompt:user-context:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:prompt:judge-user-context:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:prompt:hybrid:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:scanner:fingerprint:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:scanner_gated:${AGENT_ID}`);
    expect(deletedKeys).toContain(`agent:watches:summary:${AGENT_ID}`);
    expect(deletedKeys).toContain(`herobids:actor-health:agent:${AGENT_ID}`);
  });

  it('does NOT delete durable product state keys', async () => {
    const redis = makeRedisMock();

    await cleanupEphemeralAgentRedisState(redis, AGENT_ID);

    const pipeline = redis.pipeline.mock.results[0]!.value;
    const deletedKeys = pipeline.del.mock.calls.map((c: string[]) => c[0]);

    expect(deletedKeys).not.toContain(`agent:memory:${AGENT_ID}`);
    expect(deletedKeys).not.toContain(`agent:tasks:${AGENT_ID}`);
    expect(deletedKeys).not.toContain(`agent:reminders:${AGENT_ID}`);
    expect(deletedKeys).not.toContain(`agent:watches:${AGENT_ID}`);
    expect(deletedKeys).not.toContain(`agent:watches:notified:${AGENT_ID}`);
  });

  it('does NOT delete session-projection keys', async () => {
    const redis = makeRedisMock();

    await cleanupEphemeralAgentRedisState(redis, AGENT_ID);

    const pipeline = redis.pipeline.mock.results[0]!.value;
    const deletedKeys = pipeline.del.mock.calls.map((c: string[]) => c[0]);

    expect(deletedKeys).not.toContain('agent:sessions:active');
    expect(deletedKeys).not.toContain(`agent:sessions:count:${AGENT_ID}`);
    expect(deletedKeys).not.toContain(`agent:wake:prefs:${AGENT_ID}`);
  });

  it('is idempotent when keys are absent (pipeline.exec resolves)', async () => {
    const redis = makeRedisMock();

    // Should not throw
    await expect(cleanupEphemeralAgentRedisState(redis, AGENT_ID)).resolves.toBeUndefined();
    expect(redis.pipeline).toHaveBeenCalled();
  });

  it('swallows errors and does not throw when pipeline.exec rejects', async () => {
    const redis = makeRedisMock();
    const pipeline = redis.pipeline();
    pipeline.exec.mockRejectedValueOnce(new Error('Redis connection lost'));

    // Should not throw
    await expect(cleanupEphemeralAgentRedisState(redis, AGENT_ID)).resolves.toBeUndefined();

    // Pipeline was still attempted
    expect(redis.pipeline).toHaveBeenCalled();
  });
});
