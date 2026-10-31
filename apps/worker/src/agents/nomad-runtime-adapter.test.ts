import { describe, expect, it, vi } from 'vitest';
import { NomadRuntimeAdapter, buildNomadJobSpec } from './nomad-runtime-adapter.js';
import type { NomadRuntimeAdapterConfig } from './nomad-runtime-adapter.js';
import type { NomadClient } from './nomad-client.js';
import { RUNTIME_ERROR_CODES } from '@herobids/domain';
import type { RuntimeLaunchConfig } from '@herobids/domain';

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const baseLaunch: RuntimeLaunchConfig = {
  agentId: 'agent-1',
  sessionId: 'session-1',
  image: 'ghcr.io/poshjosh/herobids-agent:latest',
  env: { FOO: 'bar', BAZ: 'qux' },
  labels: {
    'herobids.role': 'agent',
    'herobids.agentId': 'agent-1',
  },
  resources: {
    memoryLimitMb: 512,
    cpuShares: 256,
    maxProcesses: 50,
    tempStorageMb: 100,
  },
};

const baseAdapter: NomadRuntimeAdapterConfig = {
  nomadAddr: 'http://127.0.0.1:4646',
  datacenters: ['dc1'],
  namespace: 'herobids-agents',
  agentImage: 'ghcr.io/poshjosh/herobids-agent:latest',
  defaultResources: {
    memoryLimitMb: 512,
    cpuShares: 256,
    tempStorageMb: 100,
    maxProcesses: 50,
  },
};

describe('buildNomadJobSpec', () => {
  it('serializes docker labels as a list of string→string maps', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const config = spec.Job.TaskGroups[0]!.Tasks[0]!.Config;

    // Nomad docker driver (v1.9) wants labels as []map[string]string.
    expect(Array.isArray(config.labels)).toBe(true);
    expect(config.labels.length).toBe(1);
    const labelMap = config.labels[0]!;
    expect(typeof labelMap).toBe('object');
    expect(labelMap).toEqual({
      'herobids.role': 'agent',
      'herobids.agentId': 'agent-1',
      'herobids.managed-by': 'nomad',
    });
  });

  it('keeps env at the TASK level (Env), not inside the docker Config', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const task = spec.Job.TaskGroups[0]!.Tasks[0]!;

    expect(task.Env).toEqual({ FOO: 'bar', BAZ: 'qux' });
    // The docker driver config block must NOT contain an `env` key.
    expect(task.Config).not.toHaveProperty('env');
  });

  it('uses the registry-qualified image and the agent namespace', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const config = spec.Job.TaskGroups[0]!.Tasks[0]!.Config;

    expect(config.image).toBe('ghcr.io/poshjosh/herobids-agent:latest');
    expect(spec.Job.Namespace).toBe('herobids-agents');
  });
});

// Nomad 1.9.x API shapes for JobVersion, SubmitTime and allocation NodeID come
// from the Nomad API docs, not a live cluster. Confirm them in P9.
const SUBMIT_NS = 1_700_000_000_000_000_000;
const ONE_SECOND_NS = 1_000_000_000;

const jobFixture = {
  ID: 'agent-agent-1',
  Name: 'agent-agent-1',
  Status: 'pending',
  Version: 3,
  SubmitTime: SUBMIT_NS,
  Meta: { 'herobids.role': 'agent', 'herobids.agentId': 'agent-1', 'herobids.sessionId': 'session-1' },
};

function allocationFixture(overrides: Record<string, unknown> = {}) {
  return {
    ID: 'alloc-b',
    JobID: 'agent-agent-1',
    JobVersion: 3,
    NodeID: 'node-1',
    TaskGroup: 'agent',
    ClientStatus: 'pending',
    DesiredStatus: 'run',
    CreateTime: SUBMIT_NS + ONE_SECOND_NS,
    ModifyTime: SUBMIT_NS + ONE_SECOND_NS,
    ...overrides,
  };
}

type Reply = { status?: number; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function startupAdapter(job: Reply, allocations: Reply = { body: [] }): NomadRuntimeAdapter {
  const nomadClient = {
    request: vi.fn(async (path: string) => {
      const reply = path.includes('/allocations') ? allocations : job;
      return jsonResponse(reply.body, reply.status ?? 200);
    }),
  } as unknown as NomadClient;
  return new NomadRuntimeAdapter({ ...baseAdapter, nomadClient });
}

describe('NomadRuntimeAdapter.observeStartup', () => {
  it('reports queued with the registration time when no allocation exists', async () => {
    const adapter = startupAdapter({ body: jobFixture });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toEqual({
      ok: true,
      data: { kind: 'queued', registeredAt: new Date(SUBMIT_NS / 1_000_000) },
    });
  });

  it('reports placed with the node and allocation for a valid current allocation', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      { body: [allocationFixture({ ClientStatus: 'running' })] },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toEqual({
      ok: true,
      data: {
        kind: 'placed',
        placedAt: new Date((SUBMIT_NS + ONE_SECOND_NS) / 1_000_000),
        allocationId: 'alloc-b',
        nodeId: 'node-1',
      },
    });
  });

  it('returns NOT_FOUND when the job is missing', async () => {
    const adapter = startupAdapter({ status: 404, body: {} });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.NOT_FOUND);
  });

  it('returns NOT_FOUND when the job Meta belongs to a different session', async () => {
    const adapter = startupAdapter({
      body: { ...jobFixture, Meta: { 'herobids.sessionId': 'session-other' } },
    });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.NOT_FOUND);
  });

  it('returns INSPECT_FAILED, not queued, when the job lookup errors', async () => {
    const adapter = startupAdapter({ status: 500, body: {} });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.INSPECT_FAILED);
  });

  it('returns INSPECT_FAILED, not queued, when the allocation lookup errors', async () => {
    const adapter = startupAdapter({ body: jobFixture }, { status: 500, body: {} });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.INSPECT_FAILED);
  });

  it('ignores allocations from a previous job version', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      { body: [allocationFixture({ JobVersion: 2 })] },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({ ok: true, data: { kind: 'queued' } });
  });

  it('counts a same-version allocation created before a later SubmitTime as placed', async () => {
    const adapter = startupAdapter(
      { body: { ...jobFixture, SubmitTime: SUBMIT_NS + 2 * ONE_SECOND_NS } },
      { body: [allocationFixture({ CreateTime: SUBMIT_NS + ONE_SECOND_NS, ClientStatus: 'running' })] },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({ ok: true, data: { kind: 'placed', allocationId: 'alloc-b' } });
  });

  it('returns NOT_FOUND, not queued, when the job is purged after the job lookup', async () => {
    const jobGets = [{ body: jobFixture }, { status: 404, body: {} }];
    const nomadClient = {
      request: vi.fn(async (path: string) => {
        if (path.includes('/allocations')) return jsonResponse([]);
        const reply = jobGets.shift() ?? { status: 404, body: {} };
        return jsonResponse(reply.body, reply.status ?? 200);
      }),
    } as unknown as NomadClient;
    const adapter = new NomadRuntimeAdapter({ ...baseAdapter, nomadClient });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.NOT_FOUND);
  });

  it('ignores allocations whose DesiredStatus is not run', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      { body: [allocationFixture({ DesiredStatus: 'stop' })] },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({ ok: true, data: { kind: 'queued' } });
  });

  it('ignores allocations with an empty NodeID', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      { body: [allocationFixture({ NodeID: '' })] },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({ ok: true, data: { kind: 'queued' } });
  });

  it('picks the earliest eligible allocation', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      {
        body: [
          allocationFixture({ ID: 'alloc-late', CreateTime: SUBMIT_NS + 5 * ONE_SECOND_NS, NodeID: 'node-2' }),
          allocationFixture({ ID: 'alloc-early', CreateTime: SUBMIT_NS + ONE_SECOND_NS, NodeID: 'node-1' }),
        ],
      },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({
      ok: true,
      data: { kind: 'placed', allocationId: 'alloc-early', nodeId: 'node-1' },
    });
  });

  it('breaks CreateTime ties by allocation ID', async () => {
    const adapter = startupAdapter(
      { body: jobFixture },
      {
        body: [
          allocationFixture({ ID: 'alloc-z', NodeID: 'node-z' }),
          allocationFixture({ ID: 'alloc-a', NodeID: 'node-a' }),
        ],
      },
    );

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result).toMatchObject({
      ok: true,
      data: { kind: 'placed', allocationId: 'alloc-a', nodeId: 'node-a' },
    });
  });

  it('returns an error for an invalid allocation timestamp', async () => {
    const adapter = startupAdapter({ body: jobFixture }, { body: [allocationFixture({ CreateTime: 0 })] });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.INSPECT_FAILED);
  });

  it('returns an error for an invalid job SubmitTime', async () => {
    const adapter = startupAdapter({ body: { ...jobFixture, SubmitTime: -1 } });

    const result = await adapter.observeStartup('agent-agent-1', 'session-1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RUNTIME_ERROR_CODES.INSPECT_FAILED);
  });
});