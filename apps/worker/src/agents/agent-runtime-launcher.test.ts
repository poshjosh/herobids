/**
 * Regression tests for bug 2026-06-04-012:
 * "Agent stub launcher never emits heartbeats — agents never reach `active` state"
 *
 * Root cause: AgentRuntimeLauncher stub mode never published heartbeat messages to
 * `agent:inbound:{agentId}`, so AgentSessionManager could not transition sessions
 * from `launching` → `running` → `active`.
 *
 * Fix: When a Redis client is provided, launch() starts a stub heartbeat loop that
 * publishes `agent.runtime.heartbeat` envelopes on the configured interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntimeLauncher } from './agent-runtime-launcher.js';

function makeRedis() {
  return { xadd: vi.fn().mockResolvedValue('1234-0') } as any;
}

const BASE_LAUNCH = {
  agentId: 'agent-1',
  sessionId: 'sess-1',
} as const;

describe('AgentRuntimeLauncher — stub mode heartbeats (bug-012 regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('publishes an initial heartbeat immediately after launch when Redis is provided', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis });

    await launcher.launch(BASE_LAUNCH);

    // xadd is called synchronously inside startStubHeartbeats before the first await
    expect(redis.xadd).toHaveBeenCalledOnce();

    const [streamKey, idArg, fieldName, rawEnvelope] = redis.xadd.mock.calls[0]!;
    expect(streamKey).toBe('agent:inbound:agent-1');
    expect(idArg).toBe('*');
    expect(fieldName).toBe('envelope');

    const envelope = JSON.parse(rawEnvelope as string) as Record<string, unknown>;
    expect(envelope['type']).toBe('agent.runtime.heartbeat');
    expect(envelope['schemaVersion']).toBe('v1');
    expect((envelope['payload'] as Record<string, unknown>)['sessionId']).toBe('sess-1');
    expect((envelope['payload'] as Record<string, unknown>)['status']).toBe('ready');
    expect(envelope['agentId']).toBe('agent-1');
  });

  it('publishes heartbeats on the configured interval', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis, heartbeatIntervalMs: 1000 });

    await launcher.launch(BASE_LAUNCH);
    expect(redis.xadd).toHaveBeenCalledTimes(1); // initial publish

    vi.advanceTimersByTime(1000);
    expect(redis.xadd).toHaveBeenCalledTimes(2); // first interval tick

    vi.advanceTimersByTime(1000);
    expect(redis.xadd).toHaveBeenCalledTimes(3); // second interval tick
  });

  it('uses agent:inbound:{agentId} as the stream key', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis });

    await launcher.launch({ agentId: 'my-agent', sessionId: 'my-sess' });

    expect(redis.xadd.mock.calls[0]?.[0]).toBe('agent:inbound:my-agent');
  });

  it('does not publish heartbeats and registers no timer when no Redis client is provided', async () => {
    // With no Redis, startStubHeartbeats is never called so setInterval is never
    // invoked by the launcher. Advancing time should not produce any publish calls.
    const launcher = new AgentRuntimeLauncher(); // no redis

    const handle = await launcher.launch(BASE_LAUNCH);

    expect(handle.agentId).toBe('agent-1');
    expect(handle.sessionId).toBe('sess-1');
    expect(handle.containerId).toMatch(/^stub-/);

    // Advance time well beyond any heartbeat interval — no errors should occur
    vi.advanceTimersByTime(30_000);
    // No redis mock to check, but the test verifies no errors are thrown
  });

  it('clears the heartbeat timer on stop() so no further heartbeats are published', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis, heartbeatIntervalMs: 1000 });

    await launcher.launch(BASE_LAUNCH);
    expect(redis.xadd).toHaveBeenCalledTimes(1); // initial

    await launcher.stop('sess-1');

    // Advancing time must NOT produce any additional heartbeats
    vi.advanceTimersByTime(10_000);
    expect(redis.xadd).toHaveBeenCalledTimes(1); // unchanged
  });

  it('clears the heartbeat timer on kill() so no further heartbeats are published', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis, heartbeatIntervalMs: 1000 });

    await launcher.launch(BASE_LAUNCH);
    expect(redis.xadd).toHaveBeenCalledTimes(1);

    await launcher.kill('sess-1');

    vi.advanceTimersByTime(10_000);
    expect(redis.xadd).toHaveBeenCalledTimes(1); // unchanged
  });

  it('clears all heartbeat timers on stopAll() for multiple concurrent sessions', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis, heartbeatIntervalMs: 1000 });

    await launcher.launch({ agentId: 'agent-1', sessionId: 'sess-1' });
    await launcher.launch({ agentId: 'agent-2', sessionId: 'sess-2' });
    expect(redis.xadd).toHaveBeenCalledTimes(2); // one initial per session

    await launcher.stopAll();

    vi.advanceTimersByTime(10_000);
    expect(redis.xadd).toHaveBeenCalledTimes(2); // no additional heartbeats
  });

  it('returns the same handle when launching a session that is already tracked', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({ redis });

    const first = await launcher.launch(BASE_LAUNCH);
    const second = await launcher.launch(BASE_LAUNCH); // duplicate

    expect(second).toBe(first);
    // xadd called only once — second launch is a no-op
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('uses the custom streamKeyPrefix when configured', async () => {
    const redis = makeRedis();
    const launcher = new AgentRuntimeLauncher({
      redis,
      streamKeyPrefix: 'custom:prefix:',
    });

    await launcher.launch(BASE_LAUNCH);

    expect(redis.xadd.mock.calls[0]?.[0]).toBe('custom:prefix:agent-1');
  });
});
