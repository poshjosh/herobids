import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '@herobids/domain';

// ── Logger mock ─────────────────────────────────────────────────────────────
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  }),
}));

// Mock DNS so no real network calls are made.
vi.mock('node:dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

import { webAccessTools } from './web-access.js';

const searchWebTool = webAccessTools.find((t) => t.name === 'search_web')!;
const browseUrlTool = webAccessTools.find((t) => t.name === 'browse_url')!;
const readDocumentTool = webAccessTools.find((t) => t.name === 'read_document')!;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-web-log',
    sessionId: 'session-web-log',
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

interface MockCapabilityEngine {
  checkAccess: ReturnType<typeof vi.fn>;
  recordStart: ReturnType<typeof vi.fn>;
  recordEnd: ReturnType<typeof vi.fn>;
  getGrant: ReturnType<typeof vi.fn>;
}

function makeCapabilityEngine(overrides: Partial<MockCapabilityEngine> = {}): MockCapabilityEngine {
  return {
    checkAccess: vi.fn(() => undefined),
    recordStart: vi.fn(),
    recordEnd: vi.fn(),
    getGrant: vi.fn(() => ({ limits: { maxResponseBytes: 256 * 1024, timeoutMs: 15_000 } })),
    ...overrides,
  };
}

let originalTavilyKey: string | undefined;
let originalRuntimeConfig: string | undefined;

beforeEach(() => {
  mockLoggerWarn.mockClear();
  vi.unstubAllGlobals();
  originalTavilyKey = process.env['TAVILY_API_KEY'];
  originalRuntimeConfig = process.env['AGENT_RUNTIME_CONFIG_JSON'];
});

afterEach(() => {
  if (originalTavilyKey !== undefined) {
    process.env['TAVILY_API_KEY'] = originalTavilyKey;
  } else {
    delete process.env['TAVILY_API_KEY'];
  }
  if (originalRuntimeConfig !== undefined) {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = originalRuntimeConfig;
  } else {
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// search_web — denial log structured fields
// ═══════════════════════════════════════════════════════════════════════════

describe('search_web — capability denial log structured fields', () => {
  it('logs rate_limit_exceeded with limit, used, retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'rate_limit_exceeded' as const,
        message: 'Rate limited: search_web used 5/5 times this minute. Try again in 30s.',
        retryAfterMs: 30_000,
        limit: 5,
        used: 5,
      })),
    });

    await searchWebTool.execute(
      { query: 'test' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'search_web',
      reason: 'rate_limit_exceeded',
      limit: 5,
      used: 5,
      retryAfterMs: 30_000,
    });
  });

  it('logs permanent denial with undefined limit/used/retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_disabled' as const,
        message: 'Capability search_web is disabled for this agent.',
      })),
    });

    await searchWebTool.execute(
      { query: 'test' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'search_web',
      reason: 'capability_disabled',
    });
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('uses standardized message "Capability policy denied"', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'kill_switch_active' as const,
        message: 'All tool invocations are temporarily suspended.',
      })),
    });

    await searchWebTool.execute(
      { query: 'test' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();
    expect(denialCall![1]).toBe('Capability policy denied');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// browse_url — denial log structured fields
// ═══════════════════════════════════════════════════════════════════════════

describe('browse_url — capability denial log structured fields', () => {
  it('logs rate_limit_exceeded with limit, used, retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'rate_limit_exceeded' as const,
        message: 'Rate limited: browse_url used 10/10 times this minute.',
        retryAfterMs: 45_000,
        limit: 10,
        used: 10,
      })),
    });

    await browseUrlTool.execute(
      { url: 'https://example.com' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'browse_url',
      reason: 'rate_limit_exceeded',
      limit: 10,
      used: 10,
      retryAfterMs: 45_000,
    });
  });

  it('logs permanent denial with undefined limit/used/retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_disabled' as const,
        message: 'Capability browse_url is disabled for this agent.',
      })),
    });

    await browseUrlTool.execute(
      { url: 'https://example.com' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'browse_url',
      reason: 'capability_disabled',
    });
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('uses standardized message "Capability policy denied"', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_disabled' as const,
        message: 'Capability browse_url is disabled.',
      })),
    });

    await browseUrlTool.execute(
      { url: 'https://example.com' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();
    expect(denialCall![1]).toBe('Capability policy denied');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// read_document — denial log structured fields
// ═══════════════════════════════════════════════════════════════════════════

describe('read_document — capability denial log structured fields', () => {
  it('logs rate_limit_exceeded with limit, used, retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'rate_limit_exceeded' as const,
        message: 'Rate limited: read_document used 3/3 times this minute.',
        retryAfterMs: 20_000,
        limit: 3,
        used: 3,
      })),
    });

    await readDocumentTool.execute(
      { url: 'https://example.com/doc.pdf' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'read_document',
      reason: 'rate_limit_exceeded',
      limit: 3,
      used: 3,
      retryAfterMs: 20_000,
    });
  });

  it('logs permanent denial with undefined limit/used/retryAfterMs', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'kill_switch_active' as const,
        message: 'All tool invocations are temporarily suspended.',
      })),
    });

    await readDocumentTool.execute(
      { url: 'https://example.com/doc.pdf' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-web-log',
      capability: 'read_document',
      reason: 'kill_switch_active',
    });
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('uses standardized message "Capability policy denied"', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => ({
        reason: 'capability_never_allowed' as const,
        message: 'Capability read_document is never allowed for this tier.',
      })),
    });

    await readDocumentTool.execute(
      { url: 'https://example.com/doc.pdf' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();
    expect(denialCall![1]).toBe('Capability policy denied');
  });

  it('does not emit denial log when capability check passes', async () => {
    const capabilityEngine = makeCapabilityEngine({
      checkAccess: vi.fn(() => undefined),
    });

    // Stub fetch to prevent real network calls — we just need to verify no denial log.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    ));

    await readDocumentTool.execute(
      { url: 'https://example.com/doc.pdf' },
      makeCtx({ capabilityEngine: capabilityEngine as unknown as ToolContext['capabilityEngine'] }),
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeUndefined();
  });
});
