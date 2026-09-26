import { describe, expect, it, vi } from 'vitest';
import { buildNomadJobSpec } from './nomad-runtime-adapter.js';
import type { NomadRuntimeAdapterConfig } from './nomad-runtime-adapter.js';
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
  it('serializes docker labels as a list of "key=value" strings (not a map)', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const config = spec.Job.TaskGroups[0]!.Tasks[0]!.Config;

    expect(Array.isArray(config.labels)).toBe(true);
    // Every label is a single "k=v" string; none is an object.
    for (const label of config.labels) {
      expect(typeof label).toBe('string');
      expect(label).toMatch(/=.+/);
    }
    // Includes both caller labels and the managed-by label.
    expect(config.labels).toContain('herobids.role=agent');
    expect(config.labels).toContain('herobids.agentId=agent-1');
    expect(config.labels).toContain('herobids.managed-by=nomad');
  });

  it('keeps env as a plain string→string map', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const config = spec.Job.TaskGroups[0]!.Tasks[0]!.Config;

    expect(config.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('uses the registry-qualified image and the agent namespace', () => {
    const spec = buildNomadJobSpec(baseLaunch, baseAdapter);
    const config = spec.Job.TaskGroups[0]!.Tasks[0]!.Config;

    expect(config.image).toBe('ghcr.io/poshjosh/herobids-agent:latest');
    expect(spec.Job.Namespace).toBe('herobids-agents');
  });
});