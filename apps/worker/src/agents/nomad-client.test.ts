import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NomadClient,
  isReadyNodeOfClass,
  nodeMatchesPool,
  countActiveAllocations,
  readAgentNodes,
} from './nomad-client.js';

// Suppress logger output during tests.
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('NomadClient.resolveAllServices', () => {
  const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createClient(addr = 'http://127.0.0.1:4646'): NomadClient {
    return new NomadClient({ addr, timeoutMs: 5_000 });
  }

  it('returns all entries when Nomad responds with multiple instances', async () => {
    const entries = [
      { Address: '10.0.0.1', Port: 3000, ServiceName: 'browser-pool', Namespace: 'default', ID: 'a1' },
      { Address: '10.0.0.2', Port: 3001, ServiceName: 'browser-pool', Namespace: 'default', ID: 'a2' },
      { Address: '10.0.0.3', Port: 3002, ServiceName: 'browser-pool', Namespace: 'default', ID: 'a3' },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const client = createClient();
    const result = await client.resolveAllServices('browser-pool');

    expect(result).toEqual([
      { address: '10.0.0.1', port: 3000 },
      { address: '10.0.0.2', port: 3001 },
      { address: '10.0.0.3', port: 3002 },
    ]);
  });

  it('returns a single entry when only one instance is registered', async () => {
    const entries = [
      { Address: '10.0.0.5', Port: 8080, ServiceName: 'my-service', Namespace: 'default', ID: 'x1' },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(entries), { status: 200 }));

    const result = await createClient().resolveAllServices('my-service');

    expect(result).toEqual([{ address: '10.0.0.5', port: 8080 }]);
  });

  it('returns empty array when no instances are registered', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const result = await createClient().resolveAllServices('empty-service');

    expect(result).toEqual([]);
  });

  it('returns empty array on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const result = await createClient().resolveAllServices('missing-service');

    expect(result).toEqual([]);
  });

  it('returns empty array on 500 server error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const result = await createClient().resolveAllServices('broken-service');

    expect(result).toEqual([]);
  });

  it('returns empty array when fetch throws a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await createClient().resolveAllServices('unreachable-service');

    expect(result).toEqual([]);
  });

  it('calls the correct Nomad API path with URL-encoded service name', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await createClient().resolveAllServices('my service/special');

    const calledUrl = mockFetch.mock.calls[0]![0] as string;
    expect(calledUrl).toBe('http://127.0.0.1:4646/v1/service/my%20service%2Fspecial');
  });

  it('attaches ACL token header when configured', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const client = new NomadClient({ addr: 'http://127.0.0.1:4646', token: 'secret-token' });
    await client.resolveAllServices('secure-service');

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Nomad-Token']).toBe('secret-token');
  });

  it('does not attach ACL token header when token is not configured', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await createClient().resolveAllServices('no-token-service');

    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Nomad-Token']).toBeUndefined();
  });
});

describe('NomadClient node reads', () => {
  const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createClient(): NomadClient {
    return new NomadClient({ addr: 'http://127.0.0.1:4646', timeoutMs: 5_000 });
  }

  describe('listNodes', () => {
    it('returns the node array on success', async () => {
      const nodes = [{ ID: 'n1', Status: 'ready' }, { ID: 'n2', Status: 'down' }];
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(nodes), { status: 200 }));

      expect(await createClient().listNodes()).toEqual(nodes);
    });

    it('returns null (not []) on a non-ok response, so callers keep the prior reading', async () => {
      mockFetch.mockResolvedValueOnce(new Response('denied', { status: 403 }));
      expect(await createClient().listNodes()).toBeNull();
    });

    it('returns null when the body is an error object, not an array', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Permission denied' }), { status: 200 }));
      expect(await createClient().listNodes()).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await createClient().listNodes()).toBeNull();
    });

    it('returns an empty array when the cluster has no nodes', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      expect(await createClient().listNodes()).toEqual([]);
    });
  });

  describe('getNode', () => {
    it('returns the node object on success', async () => {
      const node = { ID: 'n1', NodeClass: 'agent', NodeResources: { Memory: { MemoryMB: 4096 } } };
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(node), { status: 200 }));
      expect(await createClient().getNode('n1')).toEqual(node);
    });

    it('returns null when the body is an array, not a node object', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      expect(await createClient().getNode('n1')).toBeNull();
    });

    it('returns null on a non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('nope', { status: 500 }));
      expect(await createClient().getNode('n1')).toBeNull();
    });

    it('URL-encodes the node id in the path', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ID: 'a/b' }), { status: 200 }));
      await createClient().getNode('a/b');
      expect(mockFetch.mock.calls[0]![0]).toBe('http://127.0.0.1:4646/v1/node/a%2Fb');
    });
  });

  describe('getNodeAllocations', () => {
    it('returns the allocation array on success', async () => {
      const allocs = [{ ID: 'a1', ClientStatus: 'running' }];
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(allocs), { status: 200 }));
      expect(await createClient().getNodeAllocations('n1')).toEqual(allocs);
    });

    it('returns null (not []) on error, so a failed read is never counted as zero', async () => {
      mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
      expect(await createClient().getNodeAllocations('n1')).toBeNull();
    });

    it('returns an empty array for a node with no allocations', async () => {
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      expect(await createClient().getNodeAllocations('n1')).toEqual([]);
    });
  });
});

describe('isReadyNodeOfClass', () => {
  it('matches a ready, eligible node of the class', () => {
    expect(isReadyNodeOfClass({ ID: 'n1', Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'agent' }, 'agent')).toBe(true);
  });

  it('rejects a node that is not ready', () => {
    expect(isReadyNodeOfClass({ ID: 'n1', Status: 'down', SchedulingEligibility: 'eligible', NodeClass: 'agent' }, 'agent')).toBe(false);
  });

  it('rejects an ineligible node', () => {
    expect(isReadyNodeOfClass({ ID: 'n1', Status: 'ready', SchedulingEligibility: 'ineligible', NodeClass: 'agent' }, 'agent')).toBe(false);
  });

  it('rejects a node of a different class', () => {
    expect(isReadyNodeOfClass({ ID: 'n1', Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'browser' }, 'agent')).toBe(false);
  });
});

describe('countActiveAllocations', () => {
  it('counts running, pending, and unknown allocations as occupying', () => {
    expect(countActiveAllocations([
      { ID: 'a', ClientStatus: 'running' },
      { ID: 'b', ClientStatus: 'pending' },
      { ID: 'c', ClientStatus: 'unknown' },
    ])).toBe(3);
  });

  it('ignores completed, failed, and lost allocations', () => {
    expect(countActiveAllocations([
      { ID: 'a', ClientStatus: 'running' },
      { ID: 'b', ClientStatus: 'complete' },
      { ID: 'c', ClientStatus: 'failed' },
      { ID: 'd', ClientStatus: 'lost' },
    ])).toBe(1);
  });

  it('returns zero for no allocations', () => {
    expect(countActiveAllocations([])).toBe(0);
  });
});

describe('nodeMatchesPool', () => {
  it('matches any node when the pool is empty (no filter)', () => {
    expect(nodeMatchesPool({ ID: 'n1' }, '')).toBe(true);
    expect(nodeMatchesPool({ ID: 'n1', Meta: { node_pool: 'anything' } }, '')).toBe(true);
  });

  it('matches only a node whose Meta.node_pool equals the configured pool', () => {
    expect(nodeMatchesPool({ ID: 'n1', Meta: { node_pool: 'staging' } }, 'staging')).toBe(true);
    expect(nodeMatchesPool({ ID: 'n1', Meta: { node_pool: 'production' } }, 'staging')).toBe(false);
    expect(nodeMatchesPool({ ID: 'n1', Meta: null }, 'staging')).toBe(false);
    expect(nodeMatchesPool({ ID: 'n1' }, 'staging')).toBe(false);
  });
});

describe('readAgentNodes', () => {
  const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function clientReturning(behavior: {
    nodes: unknown;
    detail?: (id: string) => unknown;
    allocations?: (id: string) => unknown;
  }): NomadClient {
    const client = new NomadClient({ addr: 'http://127.0.0.1:4646' });
    vi.spyOn(client, 'listNodes').mockResolvedValue(behavior.nodes as never);
    vi.spyOn(client, 'getNode').mockImplementation(async (id: string) => (
      (behavior.detail ? behavior.detail(id) : { ID: id, Name: id }) as never
    ));
    vi.spyOn(client, 'getNodeAllocations').mockImplementation(async (id: string) => (
      (behavior.allocations ? behavior.allocations(id) : []) as never
    ));
    return client;
  }

  const readyAgent = (id: string) => ({ ID: id, Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'agent' });

  it('returns null when the node list is unavailable', async () => {
    const client = clientReturning({ nodes: null });
    expect(await readAgentNodes(client, '')).toBeNull();
  });

  it('returns null when any per-node read fails', async () => {
    const client = clientReturning({
      nodes: [readyAgent('n1'), readyAgent('n2')],
      allocations: (id) => (id === 'n2' ? null : []),
    });
    expect(await readAgentNodes(client, '')).toBeNull();
  });

  it('keeps only ready agent-class nodes', async () => {
    const client = clientReturning({
      nodes: [
        readyAgent('n1'),
        { ID: 'b1', Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'browser' },
        { ID: 'd1', Status: 'down', SchedulingEligibility: 'eligible', NodeClass: 'agent' },
      ],
    });
    const result = await readAgentNodes(client, '');
    expect(result?.map((s) => s.detail.ID)).toEqual(['n1']);
  });

  it('applies the pool filter on the node detail', async () => {
    const client = clientReturning({
      nodes: [readyAgent('n1'), readyAgent('n2')],
      detail: (id) => ({ ID: id, Meta: { node_pool: id === 'n1' ? 'staging' : 'production' } }),
    });
    const result = await readAgentNodes(client, 'staging');
    expect(result?.map((s) => s.detail.ID)).toEqual(['n1']);
  });

  it('returns an empty array for a genuinely empty agent fleet', async () => {
    const client = clientReturning({ nodes: [] });
    expect(await readAgentNodes(client, '')).toEqual([]);
  });
});
