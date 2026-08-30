import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BrowserlessAdapter } from './browserless-adapter.js';

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── acquireSession ──────────────────────────────────────────────────────────

describe('BrowserlessAdapter.acquireSession', () => {
  it('returns a session with cdpEndpoint and sessionId on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://browser-pool:3000/devtools/page/abc',
        id: 'abc',
      }),
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cdpEndpoint).toBe('ws://browser-pool:3000/devtools/page/abc');
      expect(result.data.sessionId).toBe('abc');
    }
  });

  it('strips trailing slash from base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://host:3000/devtools/page/x',
        id: 'x',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000/' });
    await adapter.acquireSession();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://browser-pool:3000/json/new',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('returns queue_full error on 429 status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too many sessions',
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.queue_full');
      expect(result.error.message).toContain('queue full');
    }
  });

  it('returns unavailable error on non-429 HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
      expect(result.error.message).toContain('503');
    }
  });

  it('returns unavailable error when response body text() rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error('read failed'); },
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
    }
  });

  it('returns timeout error when fetch is aborted', async () => {
    // Simulate AbortError from the AbortController timeout
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000', acquireTimeoutMs: 100 });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.timeout');
      expect(result.error.message).toContain('timed out');
    }
  });

  it('returns unavailable error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
      expect(result.error.message).toContain('ECONNREFUSED');
    }
  });

  it('returns unavailable error when response has no webSocketDebuggerUrl', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'abc' }),
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
      expect(result.error.message).toContain('incomplete');
    }
  });

  it('returns unavailable error when response has no id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://host:3000/devtools/page/x' }),
    }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('browser_pool.unavailable');
      expect(result.error.message).toContain('incomplete');
    }
  });

  it('defaults acquireTimeoutMs to 10000', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: 'ws://host:3000/devtools/page/x',
        id: 'x',
      }),
    }));

    // We cannot easily inspect the internal field, but we can verify construction succeeds
    // and the adapter works normally with default config.
    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    const result = await adapter.acquireSession();
    expect(result.ok).toBe(true);
  });
});

// ── releaseSession ──────────────────────────────────────────────────────────

describe('BrowserlessAdapter.releaseSession', () => {
  it('calls PUT /json/close/{sessionId}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    await adapter.releaseSession('session-123');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://browser-pool:3000/json/close/session-123',
      { method: 'PUT' },
    );
  });

  it('completes silently when fetch rejects (best-effort cleanup)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    // Should not throw
    await expect(adapter.releaseSession('session-123')).resolves.toBeUndefined();
  });

  it('completes silently when fetch returns an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const adapter = new BrowserlessAdapter({ url: 'http://browser-pool:3000' });
    await expect(adapter.releaseSession('session-123')).resolves.toBeUndefined();
  });
});
