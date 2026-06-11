import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';

// Mock DNS resolution so tests do not make real network calls.
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { resolve4, resolve6 } from 'node:dns/promises';
import { webAccessTools } from './web-access.js';

const webSearchTool = webAccessTools.find((t) => t.name === 'search_web')!;
const browseUrlTool = webAccessTools.find((t) => t.name === 'browse_url')!;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-web-test',
    sessionId: 'session-web-test',
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
    getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 256 * 1024, timeoutMs: 15_000 } })),
    ...overrides,
  };
}

const SAMPLE_TAVILY_RESPONSE = {
  results: [
    { title: 'Result One', url: 'https://example.com/1', content: 'Snippet one.', score: 0.9 },
    { title: 'Result Two', url: 'https://example.com/2', content: 'Snippet two.', score: 0.8 },
  ],
};

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>Sample Article</title></head>
<body>
  <article>
    <h1>Sample Article Heading</h1>
    <p>This is the first paragraph of the article with enough text.</p>
    <p>This is the second paragraph with more content for readability parsing.</p>
  </article>
</body>
</html>`;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // Default: public IPs for all DNS lookups so browse_url tests pass unless overridden
  vi.mocked(resolve4).mockResolvedValue(['1.2.3.4']);
  vi.mocked(resolve6).mockResolvedValue([]);
});

afterEach(() => {
  delete process.env['TAVILY_API_KEY'];
  delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
});

// ────────────────────────────────────────────────────────────
// search_web tests
// ────────────────────────────────────────────────────────────

describe('search_web tool', () => {
  it('returns structured results from a successful Tavily response', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_TAVILY_RESPONSE,
    }));

    const result = await webSearchTool.execute({ query: 'bitcoin price', maxResults: 2 }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      query: 'bitcoin price',
      results: [
        expect.objectContaining({ title: 'Result One', url: 'https://example.com/1', snippet: 'Snippet one.' }),
        expect.objectContaining({ title: 'Result Two', url: 'https://example.com/2', snippet: 'Snippet two.' }),
      ],
    });
  });

  it('is denied when capability policy returns a denial reason', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key';

    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => 'rate limit exceeded'),
    });

    const result = await webSearchTool.execute({ query: 'test' }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('capability policy denied');
    expect(result.retryable).toBe(false);
  });

  it('returns a clean non-retryable error when TAVILY_API_KEY is absent', async () => {
    delete process.env['TAVILY_API_KEY'];

    const result = await webSearchTool.execute({ query: 'test' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('search_web requires TAVILY_API_KEY');
    expect(result.retryable).toBe(false);
  });

  it('truncates response when combined payload exceeds maxResponseBytes', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key';

    const bigSnippet = 'x'.repeat(50_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'T', url: 'https://example.com', content: bigSnippet, score: 1 }],
      }),
    }));

    // Grant with tiny maxResponseBytes to force truncation
    const capabilityEngine = makeCapabilityEngine({
      getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 100, timeoutMs: 15_000 } })),
    });

    const result = await webSearchTool.execute({ query: 'test' }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(true);
    const data = result.data as { truncated?: boolean; results: Array<{ snippet: string }> };
    expect(data.truncated).toBe(true);
    // Final serialised payload must fit within maxResponseBytes
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(100);
  });

  it('fits a long-query fallback response within maxResponseBytes', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'T', url: 'https://example.com', content: 'x'.repeat(50_000), score: 1 }],
      }),
    }));

    const capabilityEngine = makeCapabilityEngine({
      getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 128, timeoutMs: 15_000 } })),
    });

    const result = await webSearchTool.execute({ query: 'q'.repeat(400) }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.data), 'utf8')).toBeLessThanOrEqual(128);
    expect(result.data).toMatchObject({ ok: true, truncated: true });
    expect(result.data).not.toHaveProperty('error');
  });
});

// ────────────────────────────────────────────────────────────
// browse_url tests
// ────────────────────────────────────────────────────────────

describe('browse_url tool', () => {
  it('rejects http:// URLs with a non-retryable error', async () => {
    const result = await browseUrlTool.execute({ url: 'http://example.com' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('only allows https://');
    expect(result.retryable).toBe(false);
  });

  it('rejects a URL whose hostname resolves to a private IPv4 address (192.168.x.x)', async () => {
    vi.mocked(resolve4).mockResolvedValue(['192.168.1.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await browseUrlTool.execute({ url: 'https://internal.example.com' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
    expect(result.retryable).toBe(false);
  });

  it('rejects a URL whose hostname resolves to loopback (127.0.0.1)', async () => {
    vi.mocked(resolve4).mockResolvedValue(['127.0.0.1']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const result = await browseUrlTool.execute({ url: 'https://localhost.example.com' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
  });

  it('extracts readable title and text content from valid HTML', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(SAMPLE_HTML);
    let readIndex = 0;

    const mockReader = {
      read: vi.fn(async () => {
        if (readIndex < bodyBytes.length) {
          const chunk = bodyBytes.slice(readIndex, readIndex + 1024);
          readIndex += chunk.length;
          return { done: false, value: chunk };
        }
        return { done: true, value: undefined };
      }),
      cancel: vi.fn(async () => undefined),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => mockReader },
    }));

    const result = await browseUrlTool.execute({ url: 'https://example.com/article' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(true);
    const data = result.data as { url: string; title: string; content: string; truncated: boolean };
    expect(data.url).toBe('https://example.com/article');
    expect(data.content).toBeTruthy();
    // Readability or body text extraction should have some content
    expect(data.content.length).toBeGreaterThan(0);
  });

  it('sets truncated=true when response body exceeds maxResponseBytes', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    const bigBody = '<html><head><title>Big</title></head><body>' + 'p'.repeat(1000) + '</body></html>';
    const bodyBytes = new TextEncoder().encode(bigBody);
    let readIndex = 0;

    const mockReader = {
      read: vi.fn(async () => {
        if (readIndex < bodyBytes.length) {
          const chunk = bodyBytes.slice(readIndex, readIndex + 1024);
          readIndex += chunk.length;
          return { done: false, value: chunk };
        }
        return { done: true, value: undefined };
      }),
      cancel: vi.fn(async () => undefined),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => mockReader },
    }));

    // Tiny maxResponseBytes to force truncation
    const capabilityEngine = makeCapabilityEngine({
      getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 256, timeoutMs: 15_000 } })),
    });

    const result = await browseUrlTool.execute({ url: 'https://example.com/big' }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(true);
    const data = result.data as { truncated: boolean; content: string };
    expect(data.truncated).toBe(true);
    expect(Buffer.byteLength(data.content, 'utf8')).toBeLessThanOrEqual(256);
  });

  it('aborts before streaming when Content-Length header exceeds maxResponseBytes', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name === 'content-length' ? '999999' : null },
      body: { getReader: () => ({ read: vi.fn(), cancel: vi.fn(async () => undefined) }) },
    }));

    const capabilityEngine = makeCapabilityEngine({
      getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 512 * 1024, timeoutMs: 15_000 } })),
    });

    const result = await browseUrlTool.execute({ url: 'https://example.com/huge' }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Content-Length');
    expect(result.retryable).toBe(false);
  });

  it('rejects redirects instead of following them', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: { get: (name: string) => name === 'location' ? 'https://127.0.0.1/private' : null },
      body: null,
    }));

    const result = await browseUrlTool.execute({ url: 'https://example.com/redirect' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked redirect');
    expect(result.retryable).toBe(false);
  });

  it('rejects unsupported non-HTML content types', async () => {
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']);
    vi.mocked(resolve6).mockResolvedValue([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/pdf';
          return null;
        },
      },
      body: { getReader: () => ({ read: vi.fn(), cancel: vi.fn(async () => undefined) }) },
    }));

    const result = await browseUrlTool.execute({ url: 'https://example.com/report.pdf' }, makeContext({ capabilityEngine: makeCapabilityEngine() }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported content type');
    expect(result.retryable).toBe(false);
  });

  it('is denied when capability policy returns a denial reason', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => 'capability disabled'),
    });

    const result = await browseUrlTool.execute({ url: 'https://example.com' }, makeContext({ capabilityEngine }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('capability policy denied');
    expect(result.retryable).toBe(false);
  });
});
