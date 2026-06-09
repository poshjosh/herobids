import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerRuntime } from './runtime.js';
import type { LifecycleJob } from './runtime.js';

vi.mock('bullmq', () => {
  class Queue {
    async close(): Promise<void> {}
  }

  class Worker {
    on(): void {}
    async close(): Promise<void> {}
  }

  return { Queue, Worker };
});

describe('WorkerRuntime startup cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops an active actor via stopInstanceDirect and releases the lease', async () => {
    const actor = {
      botId: 'inst-1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const lease = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(),
    };

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      async () => actor,
      undefined,
      lease as never,
    );

    await (runtime as unknown as {
      startInstance(id: string, config: Record<string, unknown>): Promise<boolean>;
    }).startInstance('inst-1', {});

    expect(runtime.activeInstances).toEqual(['inst-1']);

    await runtime.stopInstanceDirect('inst-1');

    expect(actor.stop).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledWith('inst-1');
    expect(runtime.activeInstances).toEqual([]);
  });

  it('releases the lease and does not retain the actor when actor.start fails', async () => {
    const actor = {
      botId: 'inst-1',
      start: vi.fn().mockRejectedValue(new Error('startup failed')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const lease = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(),
    };

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      async () => actor,
      undefined,
      lease as never,
    );

    await expect((runtime as unknown as {
      startInstance(id: string, config: Record<string, unknown>): Promise<boolean>;
    }).startInstance('inst-1', {})).rejects.toThrow('startup failed');

    expect(actor.stop).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledWith('inst-1');
    expect(runtime.activeInstances).toEqual([]);
  });

  it('releases the lease when actorFactory throws', async () => {
    const lease = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(),
    };

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      async () => { throw new Error('factory exploded'); },
      undefined,
      lease as never,
    );

    await expect((runtime as unknown as {
      startInstance(id: string, config: Record<string, unknown>): Promise<boolean>;
    }).startInstance('inst-1', {})).rejects.toThrow('factory exploded');

    expect(lease.release).toHaveBeenCalledWith('inst-1');
    expect(runtime.activeInstances).toEqual([]);
  });
});

/**
 * Regression: bug 2026-05-31-002 — rotation-triggered restart jobs contain only
 * { command: 'restart', botId } — no config field. The original processJob restart
 * case passed `config ?? {}` to startInstance(), which failed Zod validation.
 * Fix: when config is absent/empty, load it from the instanceLoader.
 */
describe('WorkerRuntime restart — missing config in job payload (bug 2026-05-31-002 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type RuntimePrivate = {
    processJob(job: { data: LifecycleJob }): Promise<void>;
  };

  it('loads config from instanceLoader when restart job has no config', async () => {
    const instanceConfig = { strategy: 'trend', venue: 'hyperliquid', symbol: 'BTC/USD:USD' };
    const actor = {
      botId: 'inst-1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const instanceLoader = vi.fn().mockResolvedValue([{ id: 'inst-1', config: instanceConfig }]);
    const actorFactory = vi.fn().mockResolvedValue(actor);

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      actorFactory,
      instanceLoader,
    );

    await (runtime as unknown as RuntimePrivate).processJob({
      data: { command: 'restart', botId: 'inst-1' },
    });

    expect(instanceLoader).toHaveBeenCalledTimes(1);
    expect(actorFactory).toHaveBeenCalledWith('inst-1', instanceConfig);
    expect(actor.start).toHaveBeenCalledTimes(1);
  });

  it('throws when restart job has no config and no instanceLoader is registered', async () => {
    const actor = {
      botId: 'inst-1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      async () => actor,
      // instanceLoader intentionally absent
    );

    await expect(
      (runtime as unknown as RuntimePrivate).processJob({
        data: { command: 'restart', botId: 'inst-1' },
      }),
    ).rejects.toThrow('No config available for restart of instance inst-1');
  });

  it('uses the job payload config directly and does not call instanceLoader', async () => {
    const payloadConfig = { strategy: 'mean-reversion', venue: 'bybit', symbol: 'ETH/USDT:USDT' };
    const actor = {
      botId: 'inst-1',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const instanceLoader = vi.fn().mockResolvedValue([]);
    const actorFactory = vi.fn().mockResolvedValue(actor);

    const runtime = new WorkerRuntime(
      { redis: {} as never },
      actorFactory,
      instanceLoader,
    );

    await (runtime as unknown as RuntimePrivate).processJob({
      data: { command: 'restart', botId: 'inst-1', config: payloadConfig },
    });

    expect(instanceLoader).not.toHaveBeenCalled();
    expect(actorFactory).toHaveBeenCalledWith('inst-1', payloadConfig);
    expect(actor.start).toHaveBeenCalledTimes(1);
  });
});