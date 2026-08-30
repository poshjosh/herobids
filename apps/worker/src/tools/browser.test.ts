import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ToolContext, BrowserPoolPort, BrowserSession, BrowserPoolError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

// Mock DNS (used transitively by ssrf-guard) so no real DNS lookups occur.
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

// Mock ssrf-guard so we can control isHostPrivate return values per test.
vi.mock('./ssrf-guard.js', () => ({
  isHostPrivate: vi.fn(async () => false),
}));

import { isHostPrivate } from './ssrf-guard.js';
import { createBrowserTools, cleanupBrowserSessions } from './browser.js';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-browser-test',
    sessionId: 'session-browser-test',
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

function makeBrowserPool(overrides: Partial<BrowserPoolPort> = {}): BrowserPoolPort {
  return {
    acquireSession: vi.fn(async (): Promise<Result<BrowserSession, BrowserPoolError>> =>
      ok({ cdpEndpoint: 'ws://localhost:3000/devtools/page/abc', sessionId: 'sess-1' }),
    ),
    releaseSession: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: hostname is public (not private).
  vi.mocked(isHostPrivate).mockResolvedValue(false);
});

// ── Tool registration ───────────────────────────────────────────────────────

describe('createBrowserTools — tool registration', () => {
  const tools = createBrowserTools(makeBrowserPool());
  const tool = tools[0]!;

  it('returns exactly one tool', () => {
    expect(tools).toHaveLength(1);
  });

  it('registers with name browse_interactive', () => {
    expect(tool.name).toBe('browse_interactive');
  });

  it('has category read-web', () => {
    expect(tool.category).toBe('read-web');
  });

  it('has a description mentioning browser', () => {
    expect(tool.description.toLowerCase()).toContain('browser');
  });

  it('has a valid parameters JSON schema with action enum', () => {
    const params = tool.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('type', 'object');
    const properties = params['properties'] as Record<string, Record<string, unknown>>;
    expect(properties).toHaveProperty('action');
    expect(properties['action']).toHaveProperty('enum');
    const actionEnum = properties['action']!['enum'] as string[];
    expect(actionEnum).toContain('open');
    expect(actionEnum).toContain('snapshot');
    expect(actionEnum).toContain('click');
    expect(actionEnum).toContain('fill');
    expect(actionEnum).toContain('screenshot');
    expect(actionEnum).toContain('get_text');
    expect(actionEnum).toContain('close');
  });

  it('schema includes url, selector, value, and waitFor properties', () => {
    const params = tool.parameters as Record<string, unknown>;
    const properties = params['properties'] as Record<string, unknown>;
    expect(properties).toHaveProperty('url');
    expect(properties).toHaveProperty('selector');
    expect(properties).toHaveProperty('value');
    expect(properties).toHaveProperty('waitFor');
  });
});

// ── Tool creation with undefined pool ───────────────────────────────────────

describe('createBrowserTools — no browser pool', () => {
  it('still creates a tool (pool is checked at execution time)', () => {
    const tools = createBrowserTools(undefined);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('browse_interactive');
  });

  it('returns error when executing without browser pool', async () => {
    const tools = createBrowserTools(undefined);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('browser pool not configured');
  });
});

// ── Capability gating ───────────────────────────────────────────────────────

describe('createBrowserTools — capability gating', () => {
  it('returns capability denied result when policy denies access', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_disabled' as const,
        message: 'Capability browse_interactive is disabled for this agent.',
      })),
    });

    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
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
        message: 'Rate limited: browse_interactive used 10/10 times this minute.',
        retryAfterMs: 30_000,
        limit: 10,
        used: 10,
      })),
    });

    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'snapshot' },
      makeContext({ capabilityEngine }),
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('records start and end when capability engine is present and access granted', async () => {
    const capabilityEngine = makeCapabilityEngine();

    // Pool not configured so execution is quick and deterministic
    const tools = createBrowserTools(undefined);
    const tool = tools[0]!;
    await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext({ capabilityEngine }),
    );

    expect(capabilityEngine!.recordStart).toHaveBeenCalledWith('browse_interactive', 'session-browser-test');
    expect(capabilityEngine!.recordEnd).toHaveBeenCalledWith(
      'browse_interactive',
      'session-browser-test',
      expect.objectContaining({
        capability: 'browse_interactive',
        agentId: 'agent-browser-test',
      }),
    );
  });
});

// ── Action validation ───────────────────────────────────────────────────────

describe('createBrowserTools — action validation', () => {
  it('rejects invalid action values', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'invalid_action' },
      makeContext(),
    );

    expect(result.success).toBe(false);
  });

  it('rejects missing action parameter', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      {},
      makeContext(),
    );

    expect(result.success).toBe(false);
  });

  it('rejects open action without url', async () => {
    // We need the pool to be available so execution reaches the open handler.
    // But open will fail because no url is provided.
    // Since handleOpen requires WebSocket which we can't mock easily,
    // we just test that the tool does not crash with missing url.
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('url');
  });

  it('returns error for snapshot without an active session', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'snapshot' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no active session');
  });

  it('returns error for click without selector', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'click' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('selector');
  });

  it('returns error for fill without selector', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'fill', value: 'hello' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('selector');
  });

  it('returns error for fill without value', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'fill', selector: '#name' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('value');
  });

  it('returns error for get_text without selector', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'get_text' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('selector');
  });

  it('close succeeds even without an active session', async () => {
    const tools = createBrowserTools(makeBrowserPool());
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'close' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['message']).toContain('No active session');
  });

  it('returns retryable error when pool acquisition times out', async () => {
    const pool = makeBrowserPool({
      acquireSession: vi.fn(async () => err({
        code: 'browser_pool.timeout' as const,
        message: 'Pool timed out',
      })),
    });
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe('browser_pool.timeout');
  });

  it('returns retryable error when pool queue is full', async () => {
    const pool = makeBrowserPool({
      acquireSession: vi.fn(async () => err({
        code: 'browser_pool.queue_full' as const,
        message: 'Queue full',
      })),
    });
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('returns non-retryable error when pool is unavailable', async () => {
    const pool = makeBrowserPool({
      acquireSession: vi.fn(async () => err({
        code: 'browser_pool.unavailable' as const,
        message: 'Browser pool unavailable',
      })),
    });
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.errorCode).toBe('browser_pool.unavailable');
  });
});


// ── SSRF protection in handleOpen ───────────────────────────────────────────

describe('createBrowserTools — SSRF protection', () => {
  it('rejects an invalid URL with a non-fault error', async () => {
    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'not-a-url' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    // 'not-a-url' fails Zod's .url() validation, producing a Zod error before
    // handleOpen is reached. Either way the request is rejected.
    expect(result.error).toBeDefined();
    // Should not even reach the pool
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });

  it('rejects ftp: protocol as unsupported', async () => {
    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'ftp://files.example.com/data.csv' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported protocol');
    expect(result.error).toContain('ftp:');
    expect(result.fault).toBe(false);
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });

  it('rejects javascript: protocol as unsupported', async () => {
    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'javascript:alert(1)' },
      makeContext(),
    );

    // javascript: URLs fail zod's `.url()` validation, so we get an error either way
    expect(result.success).toBe(false);
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });

  it('rejects file: protocol as unsupported', async () => {
    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'file:///etc/passwd' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported protocol');
    expect(result.error).toContain('file:');
    expect(result.fault).toBe(false);
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });

  it('blocks a hostname that resolves to a private IP', async () => {
    vi.mocked(isHostPrivate).mockResolvedValue(true);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const result = await tool.execute(
      { action: 'open', url: 'https://internal.corp.example.com/admin' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
    expect(result.fault).toBe(false);
    expect(isHostPrivate).toHaveBeenCalledWith('internal.corp.example.com');
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });

  it('allows https: URLs with public hostnames', async () => {
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;

    // This will proceed past SSRF checks but fail at WebSocket connect (expected).
    // We just verify it got past the SSRF gate by checking acquireSession was called.
    await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext(),
    );

    expect(isHostPrivate).toHaveBeenCalledWith('example.com');
    expect(pool.acquireSession).toHaveBeenCalled();
  });

  it('allows http: URLs with public hostnames', async () => {
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;

    await tool.execute(
      { action: 'open', url: 'http://example.com/page' },
      makeContext(),
    );

    expect(isHostPrivate).toHaveBeenCalledWith('example.com');
    expect(pool.acquireSession).toHaveBeenCalled();
  });

  it('runs SSRF checks before looking up an existing session', async () => {
    vi.mocked(isHostPrivate).mockResolvedValue(true);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;

    // First call might create a session key, but the SSRF check should still fire
    const result = await tool.execute(
      { action: 'open', url: 'https://evil-internal.example.com' },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private or reserved IP');
    // Pool should never be touched
    expect(pool.acquireSession).not.toHaveBeenCalled();
  });
});

// ── cleanupBrowserSessions ──────────────────────────────────────────────────

describe('cleanupBrowserSessions', () => {
  /**
   * Build a fake WebSocket that auto-responds to CDP sends so
   * CdpClient.send() resolves immediately, allowing handleOpen to succeed
   * end-to-end and register the session in activeSessions.
   */
  function installSmartFakeWebSocket(): void {
    const FakeWebSocket = class {
      static readonly OPEN = 1;
      readyState = 1;
      private listeners = new Map<string, Array<(event: unknown) => void>>();

      constructor() {
        queueMicrotask(() => {
          for (const h of this.listeners.get('open') ?? []) h({});
        });
      }

      addEventListener(event: string, handler: (event: unknown) => void): void {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(handler);
      }

      send(data: string): void {
        const parsed = JSON.parse(data) as { id: number; method: string };
        // Respond asynchronously with a success result for every CDP command
        queueMicrotask(() => {
          const response = JSON.stringify({ id: parsed.id, result: {} });
          for (const h of this.listeners.get('message') ?? []) {
            h({ data: response });
          }
        });
      }

      close(): void {
        this.readyState = 3;
        for (const h of this.listeners.get('close') ?? []) h({});
      }
    };

    vi.stubGlobal('WebSocket', FakeWebSocket);
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when no sessions exist for the agent', async () => {
    // Just calling cleanup on a non-existent agent should not throw
    await expect(cleanupBrowserSessions('nonexistent-agent')).resolves.toBeUndefined();
  });

  it('closes CDP and releases pool sessions matching the agentId prefix', async () => {
    installSmartFakeWebSocket();
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;

    const agentId = 'agent-cleanup-test';

    // Open a browser session so it gets registered in activeSessions
    const result = await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext({ agentId, sessionId: 'sess-1' }),
    );

    // The open should succeed with our smart fake WebSocket
    expect(result.success).toBe(true);
    expect(pool.releaseSession).not.toHaveBeenCalled();

    // Now cleanup
    await cleanupBrowserSessions(agentId);

    // releaseSession should have been called for the session
    expect(pool.releaseSession).toHaveBeenCalledWith('sess-1');
  });

  it('does not close sessions belonging to a different agent', async () => {
    installSmartFakeWebSocket();
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;

    // Create a session for agent-A
    await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext({ agentId: 'agent-A', sessionId: 'sess-A' }),
    );

    // Cleanup only agent-B sessions
    await cleanupBrowserSessions('agent-B');

    // agent-A's session should not have been released
    expect(pool.releaseSession).not.toHaveBeenCalled();

    // Verify agent-A's session is still active by calling snapshot
    const snapResult = await tool.execute(
      { action: 'snapshot' },
      makeContext({ agentId: 'agent-A', sessionId: 'sess-A' }),
    );
    // Should not get "no active session" error — the session is still alive
    expect(snapResult.success).toBe(true);
  });

  it('cleans up multiple sessions for the same agent', async () => {
    installSmartFakeWebSocket();
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool({
      acquireSession: vi.fn()
        .mockResolvedValueOnce(ok({ cdpEndpoint: 'ws://localhost:3000/devtools/page/a', sessionId: 'pool-sess-1' }))
        .mockResolvedValueOnce(ok({ cdpEndpoint: 'ws://localhost:3000/devtools/page/b', sessionId: 'pool-sess-2' })),
      releaseSession: vi.fn(async () => {}),
    });

    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const agentId = 'agent-multi';

    // Open two sessions (different sessionIds, same agent)
    await tool.execute(
      { action: 'open', url: 'https://example.com/page1' },
      makeContext({ agentId, sessionId: 'sess-1' }),
    );
    await tool.execute(
      { action: 'open', url: 'https://example.com/page2' },
      makeContext({ agentId, sessionId: 'sess-2' }),
    );

    await cleanupBrowserSessions(agentId);

    // Both pool sessions should have been released
    expect(pool.releaseSession).toHaveBeenCalledWith('pool-sess-1');
    expect(pool.releaseSession).toHaveBeenCalledWith('pool-sess-2');
    expect(pool.releaseSession).toHaveBeenCalledTimes(2);
  });

  it('after cleanup, session is gone (snapshot returns no-active-session error)', async () => {
    installSmartFakeWebSocket();
    vi.mocked(isHostPrivate).mockResolvedValue(false);

    const pool = makeBrowserPool();
    const tools = createBrowserTools(pool);
    const tool = tools[0]!;
    const agentId = 'agent-gone';

    await tool.execute(
      { action: 'open', url: 'https://example.com' },
      makeContext({ agentId, sessionId: 'sess-1' }),
    );

    await cleanupBrowserSessions(agentId);

    // Session should now be gone
    const snapResult = await tool.execute(
      { action: 'snapshot' },
      makeContext({ agentId, sessionId: 'sess-1' }),
    );
    expect(snapResult.success).toBe(false);
    expect(snapResult.error).toContain('no active session');
  });
});
