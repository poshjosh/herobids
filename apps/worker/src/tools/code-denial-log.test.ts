import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ToolContext } from '@herobids/domain';
import { CapabilityPolicyEngine } from '../agents/capability-policy.js';

// ── Logger mock ─────────────────────────────────────────────────────────────
// vi.hoisted ensures the variable is declared before the vi.mock factory runs.
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

import { codeTools } from './code.js';

const executeCode = codeTools.find((t) => t.name === 'execute_code')!;

const RUNTIME_CONFIG = JSON.stringify({
  tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 1_048_576 } },
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-code-log',
    sessionId: 'session-1',
    phase: 'judge',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  } as ToolContext;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('execute_code — capability denial log structured fields', () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let originalWorkspaceRoot: string | undefined;

  beforeEach(async () => {
    mockLoggerWarn.mockClear();
    originalEnv = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    originalWorkspaceRoot = process.env['AGENT_WORKSPACE_ROOT'];
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = RUNTIME_CONFIG;
    tempDir = await mkdtemp(join(os.tmpdir(), 'herobids-code-denial-log-'));
    process.env['AGENT_WORKSPACE_ROOT'] = tempDir;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      process.env['AGENT_RUNTIME_CONFIG_JSON'] = originalEnv;
    } else {
      delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    }
    if (originalWorkspaceRoot !== undefined) {
      process.env['AGENT_WORKSPACE_ROOT'] = originalWorkspaceRoot;
    } else {
      delete process.env['AGENT_WORKSPACE_ROOT'];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('logs structured fields with limit, used, retryAfterMs for rate_limit_exceeded denial', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: true, limits: { maxPerMinute: 1 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    // First call succeeds, incrementing the rate counter.
    await executeCode.execute(
      { code: 'console.log("first")', language: 'javascript', dependencies: [] },
      ctx,
    );
    mockLoggerWarn.mockClear();

    // Second call hits rate limit.
    await executeCode.execute(
      { code: 'console.log("second")', language: 'javascript', dependencies: [] },
      ctx,
    );

    // Find the denial log call (message = 'Capability policy denied').
    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-code-log',
      capability: 'execute_code',
      reason: 'rate_limit_exceeded',
    });
    expect(fields.limit).toEqual(expect.any(Number));
    expect(fields.used).toEqual(expect.any(Number));
    expect(fields.retryAfterMs).toEqual(expect.any(Number));
  });

  it('logs structured fields with undefined limit/used/retryAfterMs for permanent denial (disabled)', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: false },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeCode.execute(
      { code: 'console.log("blocked")', language: 'javascript', dependencies: [] },
      ctx,
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-code-log',
      capability: 'execute_code',
      reason: 'capability_disabled',
    });
    // Permanent denials: these fields are undefined (pino omits them).
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('logs structured fields for kill_switch_active denial', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: true },
    ]);
    engine.activateKillSwitch();
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeCode.execute(
      { code: 'console.log("killed")', language: 'javascript', dependencies: [] },
      ctx,
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();

    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      agentId: 'agent-code-log',
      capability: 'execute_code',
      reason: 'kill_switch_active',
    });
    expect(fields.limit).toBeUndefined();
    expect(fields.used).toBeUndefined();
    expect(fields.retryAfterMs).toBeUndefined();
  });

  it('uses standardized message "Capability policy denied" (not the old per-tool message)', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: false },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeCode.execute(
      { code: 'console.log("check message")', language: 'javascript', dependencies: [] },
      ctx,
    );

    // Verify the exact message string.
    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeDefined();
    expect(denialCall![1]).toBe('Capability policy denied');
  });

  it('does not emit denial log when capability check passes', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: true },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeCode.execute(
      { code: 'console.log("allowed")', language: 'javascript', dependencies: [] },
      ctx,
    );

    const denialCall = mockLoggerWarn.mock.calls.find(
      (call: unknown[]) => call[1] === 'Capability policy denied',
    );
    expect(denialCall).toBeUndefined();
  });
});
