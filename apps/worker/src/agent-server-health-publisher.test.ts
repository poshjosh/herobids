import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_HEALTH_TTL_SECONDS, type ServerHealthSnapshot } from '@herobids/domain';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';
import {
  AgentServerHealthPublisher,
  type AgentServerHealthPublisherOptions,
} from './agent-server-health-publisher.js';
import type { NomadClient, NomadNodeDetail, NomadNodeListEntry, NomadNodeAllocation } from './agents/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockRedis(): ServerHealthRedisClient & { set: ReturnType<typeof vi.fn> } {
  return { set: vi.fn().mockResolvedValue('OK') };
}

function mockLogger(): ServerHealthLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

interface NomadStubBehavior {
  nodes: NomadNodeListEntry[] | null;
  nodeDetail?: (id: string) => NomadNodeDetail | null;
  nodeAllocations?: (id: string) => NomadNodeAllocation[] | null;
}

function mockNomadClient(behavior: NomadStubBehavior): NomadClient {
  return {
    listNodes: vi.fn().mockResolvedValue(behavior.nodes),
    getNode: vi.fn(async (id: string) => (
      behavior.nodeDetail ? behavior.nodeDetail(id) : { ID: id, Name: id, NodeResources: { Memory: { MemoryMB: 4096 } } }
    )),
    getNodeAllocations: vi.fn(async (id: string) => (
      behavior.nodeAllocations ? behavior.nodeAllocations(id) : []
    )),
  } as unknown as NomadClient;
}

const readyAgentNode = (id: string, name = id): NomadNodeListEntry => ({
  ID: id,
  Name: name,
  Status: 'ready',
  SchedulingEligibility: 'eligible',
  NodeClass: 'agent',
});

function createOptions(overrides: Partial<AgentServerHealthPublisherOptions> = {}): AgentServerHealthPublisherOptions {
  return {
    redis: mockRedis(),
    nomadClient: mockNomadClient({ nodes: [] }),
    nodePool: '',
    logger: mockLogger(),
    appVersion: '1.0.0-test',
    ...overrides,
  };
}

/** Parse the snapshot written to redis.set at the given call index. */
function snapshotAt(redis: { set: ReturnType<typeof vi.fn> }, index: number): ServerHealthSnapshot {
  return JSON.parse(redis.set.mock.calls[index]![1] as string) as ServerHealthSnapshot;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentServerHealthPublisher', () => {
  describe('start / stop lifecycle', () => {
    it('is a no-op when there is no Nomad client (non-Nomad backend)', async () => {
      const redis = mockRedis();
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: undefined }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('publishes on start, then on the interval', async () => {
      const redis = mockRedis();
      const nomad = mockNomadClient({ nodes: [readyAgentNode('n1')] });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(redis.set).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(redis.set).toHaveBeenCalledTimes(2);

      publisher.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('stop() is safe to call when not started', () => {
      const publisher = new AgentServerHealthPublisher(createOptions());
      expect(() => publisher.stop()).not.toThrow();
    });
  });

  describe('snapshot content', () => {
    it('publishes one agent-server snapshot per ready agent node', async () => {
      const redis = mockRedis();
      const nomad = mockNomadClient({ nodes: [readyAgentNode('n1'), readyAgentNode('n2')] });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).toHaveBeenCalledTimes(2);
      const s0 = snapshotAt(redis, 0);
      expect(s0.serverType).toBe('agent-server');
      expect(redis.set.mock.calls[0]![0]).toBe('herobids:server-health:agent-server:n1');
      expect(redis.set.mock.calls[0]![2]).toBe('EX');
      expect(redis.set.mock.calls[0]![3]).toBe(SERVER_HEALTH_TTL_SECONDS);
    });

    it('reports allocation count and honest memory (total, used, free) from the node reads', async () => {
      const redis = mockRedis();
      const nomad = mockNomadClient({
        nodes: [readyAgentNode('n1', 'agent-1')],
        nodeDetail: () => ({ ID: 'n1', Name: 'agent-1', NodeResources: { Memory: { MemoryMB: 8192 } }, ReservedResources: { Memory: { MemoryMB: 512 } } }),
        nodeAllocations: () => [
          { ID: 'a', ClientStatus: 'running', AllocatedResources: { Tasks: { main: { Memory: { MemoryMB: 1024 } } } } },
          { ID: 'b', ClientStatus: 'pending', AllocatedResources: { Tasks: { main: { Memory: { MemoryMB: 1024 } } } } },
          { ID: 'c', ClientStatus: 'complete', AllocatedResources: { Tasks: { main: { Memory: { MemoryMB: 1024 } } } } },
        ],
      });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      const snap = snapshotAt(redis, 0);
      expect(snap.serverId).toBe('agent-1');
      // running + pending occupy; complete does not.
      expect(snap.metadata['nomadAllocations']).toBe(2);
      expect(snap.metadata['availableMemoryMb']).toBeUndefined();
      // free = 8192 − 512 reserved − (1024 + 1024 occupying) = 5632 MB
      expect(snap.memory.totalBytes).toBe(8192 * 1_048_576);
      expect(snap.memory.freeBytes).toBe(5632 * 1_048_576);
      expect(snap.memory.usedBytes).toBe((8192 - 5632) * 1_048_576);
      expect(snap.cpuPct).toBeNull();
    });

    it('ignores non-agent and not-ready nodes', async () => {
      const redis = mockRedis();
      const nomad = mockNomadClient({
        nodes: [
          readyAgentNode('n1'),
          { ID: 'b1', Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'browser' },
          { ID: 'd1', Status: 'down', SchedulingEligibility: 'eligible', NodeClass: 'agent' },
        ],
      });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(redis.set.mock.calls[0]![0]).toBe('herobids:server-health:agent-server:n1');
    });
  });

  describe('fail-soft behavior', () => {
    it('skips the whole cycle when the node list is unavailable (does not blank the group)', async () => {
      const redis = mockRedis();
      const logger = mockLogger();
      const nomad = mockNomadClient({ nodes: null });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, logger, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('skips the whole cycle when any node read fails (shared readAgentNodes is all-or-nothing)', async () => {
      const redis = mockRedis();
      const logger = mockLogger();
      const nomad = mockNomadClient({
        nodes: [readyAgentNode('n1'), readyAgentNode('n2')],
        nodeAllocations: (id) => (id === 'n1' ? null : []),
      });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, logger, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('publishes nothing (without throwing) when no agent nodes are ready', async () => {
      const redis = mockRedis();
      const nomad = mockNomadClient({ nodes: [] });
      const publisher = new AgentServerHealthPublisher(createOptions({ redis, nomadClient: nomad }));

      publisher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(redis.set).not.toHaveBeenCalled();
    });
  });
});
