import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NomadClient } from './nomad-client.js';

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
