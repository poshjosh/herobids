import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';

// Mock DNS resolution so tests do not make real network calls.
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { resolve4, resolve6 } from 'node:dns/promises';
import { httpClientTools, matchesDenyPattern, isHostDenied } from './http-client.js';

const httpRequestTool = httpClientTools.find((t) => t.name === 'http_request')!;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-http-test',
    sessionId: 'session-http-test',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

function makeCapabilityEngine(overrides: Partial<ToolContext['capabilityEngine']> = {}): ToolContext['capabilityEngine'] {
  return {
    checkAccess: vi.fn(() => undefined),
    recordStart: vi.fn(),
    recordEnd: vi.fn(),
    getGrant: vi.fn(() => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // Default: public IPs so SSRF checks pass unless overridden
  vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
  vi.mocked(resolve6).mockResolvedValue([]);
});

afterEach(() => {
  delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
});

// ── Tool registration ───────────────────────────────────────────────────────

describe('http_request tool — registration', () => {
  it('exports exactly one tool', () => {
    expect(httpClientTools).toHaveLength(1);
  });

  it('has name http_request', () => {
    expect(httpRequestTool.name).toBe('http_request');
  });

  it('has category read-web', () => {
    expect(httpRequestTool.category).toBe('read-web');
  });

  it('has a description mentioning HTTP', () => {
    expect(httpRequestTool.description).toContain('HTTP');
  });

  it('schema includes method, url, headers, body, and timeoutMs', () => {
    const params = httpRequestTool.parameters as Record<string, unknown>;
    const properties = params['properties'] as Record<string, unknown>;
    expect(properties).toHaveProperty('method');
    expect(properties).toHaveProperty('url');
    expect(properties).toHaveProperty('headers');
    expect(properties).toHaveProperty('body');
    expect(properties).toHaveProperty('timeoutMs');
  });

  it('method enum includes GET, POST, PUT, PATCH, DELETE, HEAD', () => {
    const params = httpRequestTool.parameters as Record<string, unknown>;
    const properties = params['properties'] as Record<string, Record<string, unknown>>;
    const methodEnum = properties['method']!['enum'] as string[];
    expect(methodEnum).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']));
  });
});

// ── Capability gating ───────────────────────────────────────────────────────

describe('http_request tool — capability gating', () => {
  it('returns capability denied result when policy denies access', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_disabled' as const,
        message: 'Capability http_request is disabled.',
      })),
    });

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://example.com' },
      makeContext({ capabilityEngine }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    expect(result.error).not.toContain('[object Object]');
    expect(result.fault).toBe(false);
  });

  it('returns retryable=true for rate_limit_exceeded denial', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'rate_limit_exceeded' as const,
        message: 'Rate limited.',
        retryAfterMs: 5_000,
        limit: 10,
        used: 10,
      })),
    });

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://example.com' },
      makeContext({ capabilityEngine }),
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

// ── URL validation ──────────────────────────────────────────────────────────

describe('http_request tool — URL validation', () => {
  it('rejects unsupported protocols (ftp://)', async () => {
    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'ftp://example.com/file' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    // Zod will reject ftp:// as invalid URL
  });

  it('allows HTTPS URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'hello',
    }));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(true);
  });

  it('allows HTTP URLs (protocol check allows both http and https)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'hello',
    }));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'http://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(true);
  });
});

// ── Deny-list matching ──────────────────────────────────────────────────────

describe('matchesDenyPattern', () => {
  it('matches glob pattern 10.*', () => {
    expect(matchesDenyPattern('10.0.0.1', '10.*')).toBe(true);
    expect(matchesDenyPattern('10.255.255.255', '10.*')).toBe(true);
    expect(matchesDenyPattern('110.0.0.1', '10.*')).toBe(false);
  });

  it('matches glob pattern 172.16.*', () => {
    expect(matchesDenyPattern('172.16.0.1', '172.16.*')).toBe(true);
    expect(matchesDenyPattern('172.17.0.1', '172.16.*')).toBe(false);
  });

  it('matches exact hostname', () => {
    expect(matchesDenyPattern('localhost', 'localhost')).toBe(true);
    expect(matchesDenyPattern('not-localhost', 'localhost')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(matchesDenyPattern('LOCALHOST', 'localhost')).toBe(true);
  });

  it('treats ? literally after fix', () => {
    expect(matchesDenyPattern('example.com', 'example.co?')).toBe(false);
  });
});

describe('isHostDenied', () => {
  it('returns true when hostname matches any deny pattern', () => {
    expect(isHostDenied('10.0.0.5', ['10.*', 'localhost'])).toBe(true);
    expect(isHostDenied('localhost', ['10.*', 'localhost'])).toBe(true);
  });

  it('returns false when hostname matches no deny pattern', () => {
    expect(isHostDenied('api.example.com', ['10.*', 'localhost'])).toBe(false);
  });

  it('returns false for empty deny list', () => {
    expect(isHostDenied('10.0.0.1', [])).toBe(false);
  });
});

// ── SSRF blocking ───────────────────────────────────────────────────────────

describe('http_request tool — SSRF blocking', () => {
  it('blocks hostname resolving to private IPv4 (192.168.x)', async () => {
    vi.mocked(resolve4).mockResolvedValue(['192.168.1.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://internal.example.com/api' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
    expect(result.fault).toBe(false);
  });

  it('blocks hostname resolving to loopback (127.0.0.1)', async () => {
    vi.mocked(resolve4).mockResolvedValue(['127.0.0.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://localhost.test/api' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
  });

  it('blocks unresolvable hostnames', async () => {
    vi.mocked(resolve4).mockRejectedValue(new Error('ENOTFOUND'));
    vi.mocked(resolve6).mockRejectedValue(new Error('ENOTFOUND'));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://nonexistent.invalid/api' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
  });
});

// ── Successful request execution ────────────────────────────────────────────

describe('http_request tool — request execution', () => {
  it('returns status, headers, and body on successful GET', async () => {
    const responseHeaders = new Headers({
      'content-type': 'application/json',
      'x-request-id': 'abc123',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: responseHeaders,
      text: async () => '{"result":"ok"}',
    }));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://api.example.com/data' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
      truncated: boolean;
    };
    expect(data.status).toBe(200);
    expect(data.statusText).toBe('OK');
    expect(data.headers['content-type']).toBe('application/json');
    expect(data.body).toBe('{"result":"ok"}');
    expect(data.truncated).toBe(false);
  });

  it('sends body for POST requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: new Headers(),
      text: async () => '{"id":"new-1"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    await httpRequestTool.execute(
      {
        method: 'POST',
        url: 'https://api.example.com/items',
        body: '{"name":"test"}',
        headers: { 'Content-Type': 'application/json' },
      },
      makeContext(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"test"}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('does not send body for GET requests even if provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    await httpRequestTool.execute(
      { method: 'GET', url: 'https://api.example.com', body: 'ignored' },
      makeContext(),
    );

    const callInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(callInit.body).toBeUndefined();
  });

  it('skips body reading for HEAD requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '12345' }),
      text: vi.fn(), // Should not be called
    }));

    const result = await httpRequestTool.execute(
      { method: 'HEAD', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { body: string; truncated: boolean };
    expect(data.body).toBe('');
    expect(data.truncated).toBe(false);
  });
});

// ── Response truncation ─────────────────────────────────────────────────────

describe('http_request tool — response truncation', () => {
  it('truncates response body exceeding maxResponseBytes', async () => {
    const bigBody = 'a'.repeat(500_000);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => bigBody,
    }));

    // Default maxResponseBytes is 256KB (256 * 1024)
    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://api.example.com/big' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { body: string; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(Buffer.byteLength(data.body, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('does not truncate when response fits within maxResponseBytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => 'short response',
    }));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://api.example.com/small' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { body: string; truncated: boolean };
    expect(data.truncated).toBe(false);
    expect(data.body).toBe('short response');
  });
});

// ── Timeout handling ────────────────────────────────────────────────────────

describe('http_request tool — timeout handling', () => {
  it('returns retryable error on timeout (AbortError)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'AbortError'),
    ));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://slow.example.com', timeoutMs: 1000 },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.retryable).toBe(true);
    expect(result.fault).toBe(false);
  });

  it('returns non-retryable error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await httpRequestTool.execute(
      { method: 'GET', url: 'https://down.example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// ── Capability engine telemetry ─────────────────────────────────────────────

describe('http_request tool — telemetry', () => {
  it('records start and end when capability engine is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '',
    }));

    const capabilityEngine = makeCapabilityEngine();

    await httpRequestTool.execute(
      { method: 'GET', url: 'https://example.com' },
      makeContext({ capabilityEngine }),
    );

    expect(capabilityEngine!.recordStart).toHaveBeenCalledWith('http_request', 'session-http-test');
    expect(capabilityEngine!.recordEnd).toHaveBeenCalledWith(
      'http_request',
      'session-http-test',
      expect.objectContaining({
        capability: 'http_request',
        agentId: 'agent-http-test',
        success: true,
      }),
    );
  });

  it('records end with success=false on failure', async () => {
    vi.mocked(resolve4).mockResolvedValue(['192.168.1.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const capabilityEngine = makeCapabilityEngine();

    await httpRequestTool.execute(
      { method: 'GET', url: 'https://internal.example.com' },
      makeContext({ capabilityEngine }),
    );

    expect(capabilityEngine!.recordEnd).toHaveBeenCalledWith(
      'http_request',
      'session-http-test',
      expect.objectContaining({ success: false }),
    );
  });
});
