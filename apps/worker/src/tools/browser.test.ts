import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext, BrowserPoolPort, BrowserSession, BrowserPoolError } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, link, open, readlink, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../logger.js', () => ({ createLogger: () => mockLogger }));

// Pass-through wrappers around open and readlink. Upload tests use them to fake a handle's stat or the
// /proc path that readlink reports, without changing the real file system.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), readlink: vi.fn(actual.readlink) };
});

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

// ── Form actions ────────────────────────────────────────────────────────────

describe('browse_interactive — form actions', () => {
  const FORM_AGENT_ID = 'agent-form-actions';

  // Scripted CDP socket: Runtime.evaluate replies come from evaluateReplies in order, every other command gets {}.
  // silentEvaluate makes Runtime.evaluate never answer, to exercise CDP timeouts.
  let sent: Array<{ method: string; params?: Record<string, unknown> }>;
  let evaluateReplies: unknown[];
  let silentEvaluate: boolean;
  // Fixed results for other CDP methods (for example Accessibility.getFullAXTree), and methods that fail.
  let methodReplies: Record<string, Record<string, unknown>>;
  let failingMethods: Set<string>;

  class ScriptedWebSocket {
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
      const parsed = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> };
      sent.push({ method: parsed.method, params: parsed.params });
      if (parsed.method === 'Runtime.evaluate' && silentEvaluate) return;
      const result = parsed.method === 'Runtime.evaluate'
        ? { result: { type: 'object', value: evaluateReplies.shift() } }
        : (methodReplies[parsed.method] ?? {});
      const response = failingMethods.has(parsed.method)
        ? { id: parsed.id, error: { code: -32000, message: 'No node with given id found' } }
        : { id: parsed.id, result };
      queueMicrotask(() => {
        const payload = JSON.stringify(response);
        for (const h of this.listeners.get('message') ?? []) h({ data: payload });
      });
    }

    close(): void {
      this.readyState = 3;
      for (const h of this.listeners.get('close') ?? []) h({});
    }
  }

  beforeEach(() => {
    sent = [];
    evaluateReplies = [];
    silentEvaluate = false;
    methodReplies = {};
    failingMethods = new Set();
    vi.stubGlobal('WebSocket', ScriptedWebSocket);
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await cleanupBrowserSessions(FORM_AGENT_ID);
    } finally {
      vi.unstubAllGlobals();
    }
    // A leftover reply means the code under test made fewer page calls than the test scripted.
    expect(evaluateReplies).toEqual([]);
  });

  async function openForm(sessionId: string) {
    const tool = createBrowserTools(makeBrowserPool())[0]!;
    const ctx = makeContext({ agentId: FORM_AGENT_ID, sessionId });
    const opened = await tool.execute({ action: 'open', url: 'https://example.com' }, ctx);
    expect(opened.success).toBe(true);
    sent = [];
    return { tool, ctx };
  }

  const keyEvents = () => sent.filter((c) => c.method === 'Input.dispatchKeyEvent');

  describe('element refs', () => {
    const SUBMIT_PATH = 'html > body:nth-of-type(1) > button:nth-of-type(1)';

    it('snapshot labels nodes with backend ids as refs, and a ref resolves to a CSS path for the action', async () => {
      const { tool, ctx } = await openForm('sess-ref-ok');
      methodReplies['Accessibility.getFullAXTree'] = {
        nodes: [
          { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 },
          { role: { value: 'heading' }, name: { value: 'Title' } },
        ],
      };
      methodReplies['DOM.resolveNode'] = { object: { type: 'object', objectId: 'obj-1' } };
      methodReplies['Runtime.callFunctionOn'] = { result: { type: 'string', value: SUBMIT_PATH } };
      evaluateReplies.push({ ok: true });

      const snapshot = await tool.execute({ action: 'snapshot' }, ctx);
      expect(snapshot.success).toBe(true);
      expect(snapshot.data).toMatchObject({
        snapshot: '@e1 [button] "Submit"\n[heading] "Title"',
      });

      const clicked = await tool.execute({ action: 'click', ref: '@e1' }, ctx);
      expect(clicked.success).toBe(true);

      expect(sent.find((c) => c.method === 'DOM.resolveNode')?.params).toEqual({ backendNodeId: 42 });
      expect(sent.find((c) => c.method === 'Runtime.callFunctionOn')?.params).toMatchObject({ objectId: 'obj-1' });
      const clickCall = sent.filter((c) => c.method === 'Runtime.evaluate').at(-1);
      expect(clickCall?.params?.['expression']).toContain(JSON.stringify(SUBMIT_PATH));
      expect(sent.find((c) => c.method === 'Runtime.releaseObject')?.params).toEqual({ objectId: 'obj-1' });
    });

    it('refs from an earlier snapshot are rejected after a new snapshot, even when the page has a node in the same place', async () => {
      const { tool, ctx } = await openForm('sess-ref-reset');
      methodReplies['Accessibility.getFullAXTree'] = {
        nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 }],
      };
      await tool.execute({ action: 'snapshot' }, ctx);

      methodReplies['Accessibility.getFullAXTree'] = {
        nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 43 }],
      };
      const second = await tool.execute({ action: 'snapshot' }, ctx);
      expect(second.data).toMatchObject({ snapshot: '@e2 [button] "Submit"' });
      sent = [];

      const result = await tool.execute({ action: 'click', ref: '@e1' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('unknown ref "@e1"');
      expect(sent.some((c) => c.method === 'DOM.resolveNode')).toBe(false);
    });

    it('a ref whose node has gone reports a stale ref and does not act on the page', async () => {
      const { tool, ctx } = await openForm('sess-ref-stale');
      methodReplies['Accessibility.getFullAXTree'] = {
        nodes: [{ role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 }],
      };
      await tool.execute({ action: 'snapshot' }, ctx);
      failingMethods.add('DOM.resolveNode');
      sent = [];

      const result = await tool.execute({ action: 'click', ref: '@e1' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('could not resolve ref "@e1"');
      expect(result.error).toContain('take a new snapshot');
      expect(sent.some((c) => c.method === 'Runtime.evaluate')).toBe(false);
    });

    it('rejects a ref together with a selector, and a ref on an action that takes no element', async () => {
      const { tool, ctx } = await openForm('sess-ref-invalid');

      const both = await tool.execute({ action: 'click', ref: '@e1', selector: '#go' }, ctx);
      expect(both.success).toBe(false);
      expect(both.error).toBe('browse_interactive: provide either "selector" or "ref", not both');

      const press = await tool.execute({ action: 'press', ref: '@e1', key: 'Enter' }, ctx);
      expect(press.success).toBe(false);
      expect(press.error).toBe('browse_interactive: "ref" is not supported for action "press"');
      expect(sent).toEqual([]);
    });
  });


  it('select returns an error when the read-back does not match the requested option', async () => {
    const { tool, ctx } = await openForm('sess-select');

    // Native select: the page-side write reports success, but the control reads back as Canada.
    evaluateReplies.push({ ok: true, native: true }, { ok: true, label: 'Canada', value: 'ca' });

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('browse_interactive select: expected "Germany" but the control shows "Canada"');
    expect(result.fault).toBe(false);
  });

  it('check does not click when the checkbox is already checked', async () => {
    const { tool, ctx } = await openForm('sess-check');
    evaluateReplies.push({ ok: true, checked: true });

    const result = await tool.execute({ action: 'check', selector: '#agree' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ checked: true, selector: '#agree' });
    // Only the state read runs; a click would have been a second Runtime.evaluate.
    expect(sent.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);
  });

  it('select combobox succeeds when the displayed selection matches the chosen option', async () => {
    const { tool, ctx } = await openForm('sess-combo-ok');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Germany' },
      { ok: true, expanded: 'false', selected: ['Germany'] },
    );

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ selected: 'Germany', selector: '#country' });
    expect(sent.filter((c) => c.method === 'Input.insertText')).toHaveLength(1);
  });

  it('select combobox succeeds on a multi-select when the chosen option is one of the chips', async () => {
    const { tool, ctx } = await openForm('sess-combo-multi');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Maths' },
      { ok: true, expanded: 'false', selected: ['Sports', 'Maths'] },
    );

    const result = await tool.execute({ action: 'select', selector: '#subjects', option: 'Maths' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ selected: 'Maths', selector: '#subjects' });
  });

  it('select combobox returns the available options and never presses Enter when no option matches', async () => {
    const { tool, ctx } = await openForm('sess-combo-nomatch');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: false, options: ['Canada', 'France'] },
    );

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toBe(
      'browse_interactive select: no option matches "Germany". Available options: Canada, France',
    );
    expect(keyEvents()).toHaveLength(0);
  });

  it('select combobox reports that no options are visible when the list is empty', async () => {
    const { tool, ctx } = await openForm('sess-combo-empty');
    evaluateReplies.push({ ok: true, native: false }, { clicked: false, options: [] });

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.error).toBe(
      'browse_interactive select: no option matches "Germany". No options are visible',
    );
    expect(keyEvents()).toHaveLength(0);
  });

  it('select combobox errors when typed text is the only thing the field shows', async () => {
    const { tool, ctx } = await openForm('sess-combo-typed');
    // The option was clicked, but the field only holds the typed search text and no selection is displayed.
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Germany' },
      { ok: true, expanded: 'false', selected: [] },
    );

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('browse_interactive select: expected "Germany" but no selection is shown');
  });

  it('select combobox errors when a different option is displayed after the click', async () => {
    const { tool, ctx } = await openForm('sess-combo-wrong');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Germany' },
      { ok: true, expanded: 'false', selected: ['Canada'] },
    );

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.error).toBe('browse_interactive select: expected "Germany" but the control shows "Canada"');
  });

  it('select combobox errors when the control is still expanded after the choice', async () => {
    const { tool, ctx } = await openForm('sess-combo-open');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Germany' },
      { ok: true, expanded: 'true', selected: ['Germany'] },
    );

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.error).toBe('browse_interactive select: control is still expanded after choosing "Germany"');
  });

  it('select combobox errors without a linked listbox and sends no key events', async () => {
    const { tool, ctx } = await openForm('sess-combo-nolist');
    evaluateReplies.push({ ok: true, native: false }, { clicked: false, noListbox: true });

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.success).toBe(false);
    expect(result.fault).toBe(false);
    expect(result.error).toBe(
      'browse_interactive select: combobox has no linked listbox (aria-controls is missing or does not resolve); use a native <select> or a combobox that sets aria-controls',
    );
    expect(keyEvents()).toHaveLength(0);
  });

  it('select combobox reads options and selection only through the linked listbox', async () => {
    const { tool, ctx } = await openForm('sess-combo-scope');
    evaluateReplies.push(
      { ok: true, native: false },
      { clicked: true, text: 'Germany' },
      { ok: true, expanded: 'false', selected: ['Germany'] },
    );

    await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    const [, optionLookup, selectionRead] = sent
      .filter((c) => c.method === 'Runtime.evaluate')
      .map((c) => String(c.params?.['expression']));
    expect(optionLookup).toContain("getAttribute('aria-controls')");
    expect(optionLookup).not.toContain('document.querySelectorAll');
    expect(selectionRead).toContain("getAttribute('aria-controls')");
    expect(selectionRead).not.toContain('document.querySelectorAll');
  });

  it('select combobox does not insert text when the control cannot take focus', async () => {
    const { tool, ctx } = await openForm('sess-combo-focus');
    evaluateReplies.push({ ok: false, error: 'Element could not take focus' });

    const result = await tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx);

    expect(result.error).toBe('browse_interactive select: Element could not take focus');
    expect(sent.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('select uses the 30 second timeout for page evaluation', async () => {
    const { tool, ctx } = await openForm('sess-select-timeout');
    silentEvaluate = true;
    vi.useFakeTimers();

    let settled = false;
    const pending = tool.execute({ action: 'select', selector: '#country', option: 'Germany' }, ctx)
      .then((r) => {
        settled = true;
        return r;
      });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await pending;
    expect(result.error).toBe(
      "browse_interactive select failed: CDP command 'Runtime.evaluate' timed out after 30000ms",
    );
  });

  it('type inserts text and reports the new value', async () => {
    const { tool, ctx } = await openForm('sess-type-ok');
    evaluateReplies.push({ ok: true, before: '' }, { ok: true, value: 'hello' });

    const result = await tool.execute({ action: 'type', selector: '#q', text: 'hello' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 'hello', selector: '#q' });
    const insert = sent.find((c) => c.method === 'Input.insertText');
    expect(insert?.params).toEqual({ text: 'hello' });
  });

  it('type errors when the control value does not change', async () => {
    const { tool, ctx } = await openForm('sess-type-fail');
    evaluateReplies.push({ ok: true, before: 'hello', start: 5 }, { ok: true, value: 'hello' });

    const result = await tool.execute({ action: 'type', selector: '#q', text: 'hello' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'browse_interactive type: expected "hello" to be inserted but the control shows "hello". ' +
        'If the field reformats input (for example a phone mask), the text may have been entered; check the value before retrying',
    );
  });

  it('type reports the reformatted value when a masked field changes the inserted text', async () => {
    const { tool, ctx } = await openForm('sess-type-mask');
    evaluateReplies.push({ ok: true, before: '', start: 0 }, { ok: true, value: '(555) 1' });

    const result = await tool.execute({ action: 'type', selector: '#q', text: '5551234' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('the control shows "(555) 1"');
  });

  it('type accepts identical text retyped over a selection', async () => {
    const { tool, ctx } = await openForm('sess-type-retype');
    // The field holds "hello" with all of it selected, so typing "hello" leaves the value unchanged.
    evaluateReplies.push({ ok: true, before: 'hello', start: 0 }, { ok: true, value: 'hello' });

    const result = await tool.execute({ action: 'type', selector: '#q', text: 'hello' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 'hello', selector: '#q' });
  });

  it('type without a selector rejects when nothing is focused', async () => {
    const { tool, ctx } = await openForm('sess-type-nofocus');
    evaluateReplies.push({
      ok: false,
      error: 'No focused element to type into; pass "selector" to choose one',
    });

    const result = await tool.execute({ action: 'type', text: 'hello' }, ctx);

    expect(result.error).toBe(
      'browse_interactive type: No focused element to type into; pass "selector" to choose one',
    );
    expect(sent.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('type does not insert text when the element cannot take focus', async () => {
    const { tool, ctx } = await openForm('sess-type-focus');
    evaluateReplies.push({ ok: false, error: 'Element could not take focus' });

    const result = await tool.execute({ action: 'type', selector: '#q', text: 'hello' }, ctx);

    expect(result.error).toBe('browse_interactive type: Element could not take focus');
    expect(sent.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('press sends key down and key up for a supported key', async () => {
    const { tool, ctx } = await openForm('sess-press-ok');

    const result = await tool.execute({ action: 'press', key: 'Escape' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ pressed: 'Escape' });
    const events = keyEvents().map((c) => c.params);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  });

  it('press rejects an unknown key without sending any key event', async () => {
    const { tool, ctx } = await openForm('sess-press-bad');

    const result = await tool.execute({ action: 'press', key: 'NotAKey' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('browse_interactive: unsupported key "NotAKey"');
    expect(keyEvents()).toHaveLength(0);
  });

  it('uncheck clicks a checked control and reports the new state', async () => {
    const { tool, ctx } = await openForm('sess-uncheck-ok');
    evaluateReplies.push({ ok: true, checked: true }, {}, { ok: true, checked: false });

    const result = await tool.execute({ action: 'uncheck', selector: '#agree' }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ checked: false, selector: '#agree' });
  });

  it('check errors when the control does not change state after the click', async () => {
    const { tool, ctx } = await openForm('sess-check-mismatch');
    evaluateReplies.push({ ok: true, checked: false }, {}, { ok: true, checked: false });

    const result = await tool.execute({ action: 'check', selector: '#agree' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('browse_interactive check: expected checked=true but the control reports checked=false');
  });

  it('uncheck errors when the control does not change state after the click', async () => {
    const { tool, ctx } = await openForm('sess-uncheck-mismatch');
    evaluateReplies.push({ ok: true, checked: true }, {}, { ok: true, checked: true });

    const result = await tool.execute({ action: 'uncheck', selector: '#agree' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe('browse_interactive uncheck: expected checked=false but the control reports checked=true');
  });

  describe('upload', () => {
    const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
    let workspaceRoot: string;
    let outsideDir: string;
    let previousRootEnv: string | undefined;

    beforeEach(async () => {
      previousRootEnv = process.env['AGENT_WORKSPACE_ROOT'];
      workspaceRoot = await mkdtemp(join(tmpdir(), 'browser-upload-root-'));
      outsideDir = await mkdtemp(join(tmpdir(), 'browser-upload-outside-'));
      process.env['AGENT_WORKSPACE_ROOT'] = workspaceRoot;
    });

    afterEach(async () => {
      if (previousRootEnv === undefined) delete process.env['AGENT_WORKSPACE_ROOT'];
      else process.env['AGENT_WORKSPACE_ROOT'] = previousRootEnv;
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    const pageCalls = () => sent.filter((c) => c.method === 'Runtime.evaluate');

    it('upload rejects a path that escapes the workspace with ..', async () => {
      const { tool, ctx } = await openForm('sess-upload-dotdot');

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: '../secret.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: path traversal is not allowed');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects an absolute path outside the workspace root', async () => {
      const { tool, ctx } = await openForm('sess-upload-absolute');
      const outsideFile = join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'secret');

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: outsideFile }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: path must be relative to the workspace root');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a symlink that resolves outside the workspace root', async () => {
      const { tool, ctx } = await openForm('sess-upload-symlink');
      const outsideFile = join(outsideDir, 'secret.txt');
      await writeFile(outsideFile, 'secret');
      await symlink(outsideFile, join(workspaceRoot, 'link.txt'));

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'link.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: path escapes workspace root');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a file over the 10 MiB limit before reading it', async () => {
      const { tool, ctx } = await openForm('sess-upload-oversize');
      const bigFile = join(workspaceRoot, 'big.pdf');
      await writeFile(bigFile, '');
      await truncate(bigFile, UPLOAD_LIMIT_BYTES + 1);

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'big.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe(`browse_interactive upload: "big.pdf" is ${UPLOAD_LIMIT_BYTES + 1} bytes, over the 10 MiB upload limit`);
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a directory', async () => {
      const { tool, ctx } = await openForm('sess-upload-directory');
      await mkdir(join(workspaceRoot, 'docs'));

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'docs' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: "docs" is a directory, not a file');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload attaches a workspace file and reports name, size and file count', async () => {
      const { tool, ctx } = await openForm('sess-upload-ok');
      await mkdir(join(workspaceRoot, 'docs'));
      await writeFile(join(workspaceRoot, 'docs', 'cv.pdf'), 'hello');
      // Replies in call order: prepare, one chunk ("hello" as base64), then inject and read back.
      evaluateReplies.push(
        { ok: true },
        { ok: true },
        { ok: true, name: 'cv.pdf', size: 5, count: 1, url: 'https://jobs.example.com/apply' },
      );

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'docs/cv.pdf' }, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ fileName: 'cv.pdf', sizeBytes: 5, filesCount: 1, selector: '#resume' });
      const expressions = pageCalls().map((c) => String(c.params?.['expression']));
      expect(expressions).toHaveLength(3);
      expect(expressions[1]).toContain(JSON.stringify('aGVsbG8='));
      expect(sent.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('upload accepts a file under docs/original in the workspace root', async () => {
      const { tool, ctx } = await openForm('sess-upload-user-doc');
      await mkdir(join(workspaceRoot, 'docs', 'original'), { recursive: true });
      await writeFile(join(workspaceRoot, 'docs', 'original', 'Helen_CV.pdf'), 'hello');
      evaluateReplies.push(
        { ok: true },
        { ok: true },
        { ok: true, name: 'Helen_CV.pdf', size: 5, count: 1, url: 'https://jobs.example.com/apply' },
      );

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'docs/original/Helen_CV.pdf' }, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ fileName: 'Helen_CV.pdf', sizeBytes: 5, filesCount: 1, selector: '#resume' });
    });

    it('upload logs the real source path, the sha256 and size, and a page URL without its query', async () => {
      const { tool, ctx } = await openForm('sess-upload-audit');
      const cvPath = join(workspaceRoot, 'cv.pdf');
      await writeFile(cvPath, 'hello');
      evaluateReplies.push(
        { ok: true },
        { ok: true },
        { ok: true, name: 'cv.pdf', size: 5, count: 1, url: 'https://jobs.example.com/apply?token=secret#step' },
      );

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: FORM_AGENT_ID,
          sessionId: 'sess-upload-audit',
          sourcePath: await realpath(cvPath),
          sizeBytes: 5,
          sha256: createHash('sha256').update('hello').digest('hex'),
          pageUrl: 'https://jobs.example.com/apply',
        }),
        'browse_interactive upload attached file',
      );
    });

    it('upload clears the page staging key when a chunk transfer fails', async () => {
      const { tool, ctx } = await openForm('sess-upload-chunk-fail');
      await writeFile(join(workspaceRoot, 'cv.pdf'), 'hello');
      evaluateReplies.push({ ok: true }, { ok: false, error: 'chunk transfer failed' }, true);

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('browse_interactive upload: chunk transfer failed');
      const stagingKey = /window\[("__herobidsUpload_[^"]+")\]/.exec(String(pageCalls()[0]!.params?.['expression']))![1];
      expect(pageCalls()).toHaveLength(3);
      expect(String(pageCalls()[2]!.params?.['expression'])).toBe(`delete window[${stagingKey}]`);
    });

    it('upload sends a file over 512 KiB in two chunks that reassemble to the source bytes', async () => {
      const { tool, ctx } = await openForm('sess-upload-multichunk');
      const bytes = randomBytes(700 * 1024);
      await writeFile(join(workspaceRoot, 'big.bin'), bytes);
      evaluateReplies.push(
        { ok: true },
        { ok: true },
        { ok: true },
        { ok: true, name: 'big.bin', size: bytes.length, count: 1, url: 'https://jobs.example.com/apply' },
      );

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'big.bin' }, ctx);

      expect(result.success).toBe(true);
      const chunkExpressions = pageCalls()
        .map((c) => String(c.params?.['expression']))
        .filter((e) => e.includes('parts.push('));
      expect(chunkExpressions).toHaveLength(2);
      const base64 = chunkExpressions
        .map((e) => JSON.parse(/parts\.push\((".*?")\)/.exec(e)![1]!) as string)
        .join('');
      expect(createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'))
        .toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('upload stops with a non-fault error when the 60 s deadline passes between chunks', async () => {
      const { tool, ctx } = await openForm('sess-upload-deadline');
      await writeFile(join(workspaceRoot, 'big.bin'), randomBytes(700 * 1024));
      // The clock stays put until two page calls have gone out, then jumps past the 60 s budget before the second chunk.
      const start = Date.now();
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (pageCalls().length >= 2 ? start + 60_001 : start));
      evaluateReplies.push({ ok: true }, { ok: true }, true);

      let result;
      try {
        result = await tool.execute({ action: 'upload', selector: '#resume', file: 'big.bin' }, ctx);
      } finally {
        nowSpy.mockRestore();
      }

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: timed out before the file finished transferring');
      // prepare, one chunk, then the staging cleanup in finally.
      expect(pageCalls()).toHaveLength(3);
      expect(String(pageCalls()[2]!.params?.['expression'])).toMatch(/^delete window\[/);
    });

    it('upload rejects a file that grows past the limit after its size was checked', async () => {
      const { tool, ctx } = await openForm('sess-upload-grew');
      const grewPath = join(workspaceRoot, 'grew.pdf');
      await writeFile(grewPath, '');
      await truncate(grewPath, UPLOAD_LIMIT_BYTES + 1);
      // The handle's stat reports a small file, but the bytes read back are over the cap.
      const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
      vi.mocked(open).mockImplementationOnce(async (path, flags) => {
        const handle = await actualOpen(path, flags);
        const real = await handle.stat();
        handle.stat = async () => Object.assign(Object.create(Object.getPrototypeOf(real)), real, { size: 1 });
        return handle;
      });

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'grew.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: "grew.pdf" grew past the upload limit while it was read');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a FIFO without blocking on it', async () => {
      const { tool, ctx } = await openForm('sess-upload-fifo');
      await promisify(execFile)('mkfifo', [join(workspaceRoot, 'pipe.fifo')]);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('upload hung on the FIFO')), 5_000);
      });
      try {
        const result = await Promise.race([
          tool.execute({ action: 'upload', selector: '#resume', file: 'pipe.fifo' }, ctx),
          timeout,
        ]);

        expect(result.success).toBe(false);
        expect(result.fault).toBe(false);
        expect(result.error).toBe('browse_interactive upload: "pipe.fifo" is not a regular file');
        expect(pageCalls()).toHaveLength(0);
      } finally {
        clearTimeout(timer);
      }
    });

    it('upload rejects a file whose opened path resolves outside the workspace root', async () => {
      const { tool, ctx } = await openForm('sess-upload-fd-escape');
      await writeFile(join(workspaceRoot, 'cv.pdf'), 'hello');
      // Stands in for /proc/self/fd/N naming a path outside the root, as after a parent directory swap.
      vi.mocked(readlink).mockResolvedValueOnce(join(outsideDir, 'cv.pdf'));

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: path escapes workspace root');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a handle whose opened path differs from the checked file, even inside the root', async () => {
      const { tool, ctx } = await openForm('sess-upload-fd-sibling');
      await writeFile(join(workspaceRoot, 'cv.pdf'), 'hello');
      await writeFile(join(workspaceRoot, 'other.pdf'), 'world');
      vi.mocked(readlink).mockResolvedValueOnce(join(workspaceRoot, 'other.pdf'));

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe('browse_interactive upload: path escapes workspace root');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a file whose inode changes between open and the identity check', async () => {
      const { tool, ctx } = await openForm('sess-upload-ino');
      const cvPath = join(workspaceRoot, 'cv.pdf');
      await writeFile(cvPath, 'hello');
      // The handle reports a different inode than stat(realFile) returns, as after a swap.
      const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
      vi.mocked(open).mockImplementationOnce(async (path, flags) => {
        const handle = await actualOpen(path, flags);
        const real = await handle.stat();
        handle.stat = async () => Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: real.ino + 1 });
        return handle;
      });

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: "cv.pdf" changed while it was being opened');
      expect(pageCalls()).toHaveLength(0);
    });

    it('upload rejects a file that has a second hard link inside the workspace', async () => {
      const { tool, ctx } = await openForm('sess-upload-hardlink');
      await writeFile(join(workspaceRoot, 'cv.pdf'), 'hello');
      await link(join(workspaceRoot, 'cv.pdf'), join(workspaceRoot, 'cv-copy.pdf'));

      const result = await tool.execute({ action: 'upload', selector: '#resume', file: 'cv.pdf' }, ctx);

      expect(result.success).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.error).toBe('browse_interactive upload: "cv.pdf" has more than one hard link');
      expect(pageCalls()).toHaveLength(0);
    });
  });
});

