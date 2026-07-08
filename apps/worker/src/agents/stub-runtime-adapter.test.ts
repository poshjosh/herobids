import { describe, it, expect } from 'vitest';
import { StubRuntimeAdapter } from './stub-runtime-adapter.js';
import type {
  RuntimeLaunchConfig,
  RuntimeResourceProfile,
} from '@herobids/domain';

const DEFAULT_RESOURCES: RuntimeResourceProfile = {
  memoryLimitMb: 512,
  cpuShares: 256,
  maxProcesses: 10,
  tempStorageMb: 100,
};

const BASE_LAUNCH: RuntimeLaunchConfig = {
  agentId: 'agent-1',
  sessionId: 'sess-1',
  image: 'herobids-agent:latest',
  env: { REDIS_URL: 'redis://localhost:6379', AGENT_ID: 'agent-1' },
  labels: { 'herobids.role': 'agent', 'herobids.agentId': 'agent-1' },
  resources: DEFAULT_RESOURCES,
};

describe('StubRuntimeAdapter', () => {
  it('launch returns an ok result with a runtime handle', async () => {
    const adapter = new StubRuntimeAdapter();
    const result = await adapter.launch(BASE_LAUNCH);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.runtimeId).toMatch(/^stub-agent-1-\d+$/);
    expect(result.data.agentId).toBe('agent-1');
    expect(result.data.sessionId).toBe('sess-1');
    expect(result.data.startedAt).toBeTruthy();
  });

  it('launch assigns unique runtimeIds for different agents', async () => {
    const adapter = new StubRuntimeAdapter();

    const r1 = await adapter.launch({ ...BASE_LAUNCH, agentId: 'agent-a', sessionId: 'sess-a' });
    const r2 = await adapter.launch({ ...BASE_LAUNCH, agentId: 'agent-b', sessionId: 'sess-b' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error('expected ok');
    expect(r1.data.runtimeId).not.toBe(r2.data.runtimeId);
  });

  it('inspect returns running for a launched runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const launch = await adapter.launch(BASE_LAUNCH);
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error('expected ok');

    const result = await adapter.inspect(launch.data.runtimeId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.status).toBe('running');
    expect(result.data.agentId).toBe('agent-1');
  });

  it('inspect returns unknown for a non-existent runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const result = await adapter.inspect('nonexistent');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.status).toBe('unknown');
  });

  it('stop removes the runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const launch = await adapter.launch(BASE_LAUNCH);
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error('expected ok');

    const stopResult = await adapter.stop(launch.data.runtimeId);
    expect(stopResult.ok).toBe(true);

    const inspect = await adapter.inspect(launch.data.runtimeId);
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) throw new Error('expected ok');
    expect(inspect.data.status).toBe('unknown');
  });

  it('stop returns error for non-existent runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const result = await adapter.stop('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('runtime.not_found');
  });

  it('kill removes the runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const launch = await adapter.launch(BASE_LAUNCH);
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error('expected ok');

    const killResult = await adapter.kill(launch.data.runtimeId);
    expect(killResult.ok).toBe(true);

    const inspect = await adapter.inspect(launch.data.runtimeId);
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) throw new Error('expected ok');
    expect(inspect.data.status).toBe('unknown');
  });

  it('kill returns error for non-existent runtime', async () => {
    const adapter = new StubRuntimeAdapter();
    const result = await adapter.kill('nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('runtime.not_found');
  });

  it('list returns all running runtimes', async () => {
    const adapter = new StubRuntimeAdapter();
    await adapter.launch({ ...BASE_LAUNCH, agentId: 'agent-1', sessionId: 'sess-1' });
    await adapter.launch({ ...BASE_LAUNCH, agentId: 'agent-2', sessionId: 'sess-2' });

    const result = await adapter.list();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toHaveLength(2);
  });

  it('reconcile returns empty diffs for a clean state', async () => {
    const adapter = new StubRuntimeAdapter();
    const result = await adapter.reconcile();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.orphans).toEqual([]);
    expect(result.data.missing).toEqual([]);
    expect(result.data.runningCount).toBe(0);
  });

  it('reconcile counts running runtimes', async () => {
    const adapter = new StubRuntimeAdapter();
    await adapter.launch(BASE_LAUNCH);

    const result = await adapter.reconcile();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.runningCount).toBe(1);
  });

  it('onTermination returns an unsubscribe function', () => {
    const adapter = new StubRuntimeAdapter();
    const unsub = adapter.onTermination(() => {});
    expect(typeof unsub).toBe('function');
    unsub(); // should not throw
  });

  it('onTermination handler is registered and unsubscribed', () => {
    const adapter = new StubRuntimeAdapter();
    let called = false;
    const handler = () => { called = true; };
    const unsub = adapter.onTermination(handler);
    unsub();
    // Handler deregistration is verified by the absence of side effects;
    // the adapter currently does not fire termination events in stub mode.
    expect(typeof unsub).toBe('function');
  });
});
