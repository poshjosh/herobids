/**
 * Tests for Docker container helper functions in admin-utils.
 *
 * `dockerSocketGet` performs real I/O (Unix socket or TCP). We replace
 * `dockerIo.get` (the indirection layer) with a mock so the higher-level
 * functions can be tested without touching the Docker daemon.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dockerIo,
  dockerSocketGetAgentContainers,
  getRunningContainerCount,
} from './admin-utils.js';

// Keep a reference to the real implementation so we can restore it.
const realDockerSocketGet = dockerIo.get;

beforeEach(() => {
  // Replace the I/O boundary with a mock for each test.
  dockerIo.get = vi.fn();
});

afterEach(() => {
  dockerIo.get = realDockerSocketGet;
});

/** Typed helper to access the mock. */
function mockGet() {
  return dockerIo.get as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// dockerSocketGetAgentContainers
// ---------------------------------------------------------------------------

describe('dockerSocketGetAgentContainers', () => {
  it('returns the container array from Docker', async () => {
    const containers = [{ Id: 'c1', Names: ['/agent-1'] }, { Id: 'c2', Names: ['/agent-2'] }];
    mockGet().mockResolvedValue(containers);

    const result = await dockerSocketGetAgentContainers();
    expect(result).toEqual(containers);
    expect(result).toHaveLength(2);
  });

  it('passes the correct filter path to dockerSocketGet', async () => {
    mockGet().mockResolvedValue([]);

    await dockerSocketGetAgentContainers();

    expect(mockGet()).toHaveBeenCalledOnce();
    const callPath = mockGet().mock.calls[0]![0] as string;
    expect(callPath).toContain('/containers/json');
    expect(callPath).toContain('all=false');
    expect(callPath).toContain('size=1');
    // The filter includes the herobids.role=agent label
    expect(callPath).toContain('herobids.role');
  });

  it('returns empty array when Docker returns a non-array response', async () => {
    mockGet().mockResolvedValue({ message: 'unexpected' });

    const result = await dockerSocketGetAgentContainers();
    expect(result).toEqual([]);
  });

  it('returns empty array when Docker returns null', async () => {
    mockGet().mockResolvedValue(null);

    const result = await dockerSocketGetAgentContainers();
    expect(result).toEqual([]);
  });

  it('propagates errors from dockerSocketGet', async () => {
    mockGet().mockRejectedValue(new Error('Docker socket timeout'));

    await expect(dockerSocketGetAgentContainers()).rejects.toThrow('Docker socket timeout');
  });
});

// ---------------------------------------------------------------------------
// getRunningContainerCount
// ---------------------------------------------------------------------------

describe('getRunningContainerCount', () => {
  it('returns the count of running agent containers', async () => {
    mockGet().mockResolvedValue([{ Id: 'c1' }, { Id: 'c2' }, { Id: 'c3' }]);

    const result = await getRunningContainerCount();
    expect(result).toBe(3);
  });

  it('returns 0 when no containers are running', async () => {
    mockGet().mockResolvedValue([]);

    const result = await getRunningContainerCount();
    expect(result).toBe(0);
  });

  it('returns null when Docker socket is unavailable (ENOENT)', async () => {
    mockGet().mockRejectedValue(new Error('ENOENT: /var/run/docker.sock'));

    const result = await getRunningContainerCount();
    expect(result).toBeNull();
  });

  it('returns null when Docker socket times out', async () => {
    mockGet().mockRejectedValue(new Error('Docker socket timeout'));

    const result = await getRunningContainerCount();
    expect(result).toBeNull();
  });

  it('returns null when Docker returns non-JSON', async () => {
    mockGet().mockRejectedValue(new Error('Non-JSON response from Docker socket'));

    const result = await getRunningContainerCount();
    expect(result).toBeNull();
  });

  it('returns null when Docker TCP connection is refused', async () => {
    mockGet().mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await getRunningContainerCount();
    expect(result).toBeNull();
  });

  it('returns 0 for non-array Docker response (normalised by dockerSocketGetAgentContainers)', async () => {
    // dockerSocketGetAgentContainers normalises non-array results to []
    mockGet().mockResolvedValue({ error: 'page not found' });

    const result = await getRunningContainerCount();
    expect(result).toBe(0);
  });
});
