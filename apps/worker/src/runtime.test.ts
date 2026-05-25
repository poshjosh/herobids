import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerRuntime } from './runtime.js';

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

  it('releases the lease and does not retain the actor when actor.start fails', async () => {
    const actor = {
      tradingInstanceId: 'inst-1',
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