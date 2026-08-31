import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ToolContext } from '@herobids/domain';
import { shellTools } from './shell.js';
import { CapabilityPolicyEngine } from '../agents/capability-policy.js';

const executeShellTool = shellTools.find((t) => t.name === 'execute_shell')!;

const RUNTIME_CONFIG = JSON.stringify({
  tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 1_048_576 } },
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    authorizationMode: 'direct',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
      blpop: vi.fn(async () => null),
      smembers: vi.fn(async () => []),
      sadd: vi.fn(async () => 0),
      srem: vi.fn(async () => 0),
      expire: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('execute_shell tool', () => {
  let originalRuntimeConfig: string | undefined;
  let originalAgentConfig: string | undefined;
  let originalWorkspaceRoot: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalRuntimeConfig = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    originalAgentConfig = process.env['AGENT_CONFIG'];
    originalWorkspaceRoot = process.env['AGENT_WORKSPACE_ROOT'];

    process.env['AGENT_RUNTIME_CONFIG_JSON'] = RUNTIME_CONFIG;
    // Use 'full' for non-mocked execution tests so commands run directly as
    // the current user (sh -lc). Permission-level-specific behaviour is covered
    // by dedicated mocked tests below.
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });

    tempDir = await mkdtemp(join(os.tmpdir(), 'herobids-shell-test-'));
    process.env['AGENT_WORKSPACE_ROOT'] = tempDir;
  });

  afterEach(async () => {
    if (originalRuntimeConfig !== undefined) {
      process.env['AGENT_RUNTIME_CONFIG_JSON'] = originalRuntimeConfig;
    } else {
      delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    }
    if (originalAgentConfig !== undefined) {
      process.env['AGENT_CONFIG'] = originalAgentConfig;
    } else {
      delete process.env['AGENT_CONFIG'];
    }
    if (originalWorkspaceRoot !== undefined) {
      process.env['AGENT_WORKSPACE_ROOT'] = originalWorkspaceRoot;
    } else {
      delete process.env['AGENT_WORKSPACE_ROOT'];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Metadata ──────────────────────────────────────────────────────────────

  it('is exported from shellTools', () => {
    expect(executeShellTool).toBeDefined();
  });

  it('has name execute_shell', () => {
    expect(executeShellTool.name).toBe('execute_shell');
  });

  it('has category execute-filesystem', () => {
    expect(executeShellTool.category).toBe('execute-filesystem');
  });

  it('has a description mentioning permission levels', () => {
    expect(executeShellTool.description).toContain('permission level');
  });

  it('has a JSON parameters object for LLM function calling', () => {
    expect(executeShellTool.parameters).toBeDefined();
    expect(typeof executeShellTool.parameters).toBe('object');
  });

  // ── Basic execution ───────────────────────────────────────────────────────

  it('executes a simple shell command and returns structured output', async () => {
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo "hello from shell"' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('hello from shell');
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(0);
    expect(typeof (result.data as Record<string, unknown>)['durationMs']).toBe('number');
  });

  it('returns success:false with structured data on nonzero exit code', async () => {
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'exit 2' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(2);
    expect(typeof (result.data as Record<string, unknown>)['durationMs']).toBe('number');
  });

  // ── Permission level gating ───────────────────────────────────────────────

  it('rejects execution for restricted permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'restricted' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo test' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('execute_shell.permission_denied');
    expect(result.error).toContain('restricted');
    expect(result.error).toContain('execute_code');
    expect(result.retryable).toBe(false);
  });

  it('allows execution for standard permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'standard' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo standard' },
      ctx,
    );

    // May fail if 'agent' user does not exist in test env, but should not be permission_denied
    expect(result.errorCode).not.toBe('execute_shell.permission_denied');
  });

  it('allows execution for full permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo full' },
      ctx,
    );

    // May fail if sudo is not installed in test env, but should not be permission_denied
    expect(result.errorCode).not.toBe('execute_shell.permission_denied');
  });

  it('defaults to standard when AGENT_CONFIG is missing', async () => {
    delete process.env['AGENT_CONFIG'];
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo default' },
      ctx,
    );

    // Defaults to standard — may fail if 'agent' user does not exist in test env,
    // but should not be permission_denied
    expect(result.errorCode).not.toBe('execute_shell.permission_denied');
  });

  // ── Runtime policy ────────────────────────────────────────────────────────

  it('returns error when AGENT_RUNTIME_CONFIG_JSON is missing', async () => {
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo test' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('execute_shell.missing_runtime_policy');
  });

  // ── Timeout ───────────────────────────────────────────────────────────────

  it('respects explicit timeoutMs', async () => {
    const ctx = makeCtx();
    const start = Date.now();
    const result = await executeShellTool.execute(
      { command: 'sleep 60', timeoutMs: 1_000 },
      ctx,
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(8_000);
  });

  // ── Working directory ─────────────────────────────────────────────────────

  it('rejects path traversal in workingDir for standard permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'standard' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'pwd', workingDir: '../../etc' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('execute_shell.invalid_working_dir');
  });

  it('rejects absolute path in workingDir for standard permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'standard' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'pwd', workingDir: '/etc' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('execute_shell.invalid_working_dir');
  });

  // ── Capability policy ─────────────────────────────────────────────────────

  it('enforces capability policy denial', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: false },
    ]);
    const ctx = { ...makeCtx(), capabilityEngine: engine };
    const result = await executeShellTool.execute(
      { command: 'echo test' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability.policy_denied');
    expect(result.error).toContain('disabled');
    expect(result.retryable).toBe(false);
  });

  it('enforces rate limiting', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxPerMinute: 1 } },
    ]);
    const ctx = { ...makeCtx(), capabilityEngine: engine };

    const first = await executeShellTool.execute({ command: 'echo first' }, ctx);
    expect(first.success).toBe(true);

    const second = await executeShellTool.execute({ command: 'echo second' }, ctx);
    expect(second.success).toBe(false);
    expect(second.errorCode).toBe('capability.policy_denied');
    expect(second.error).toContain('Rate limited');
    expect(second.retryable).toBe(true);
  });

  // ── Output truncation ─────────────────────────────────────────────────────

  it('truncates stdout to MAX_OUTPUT bytes', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({
      tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 10 } },
    });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'printf "a%.0s" {1..100}' },
      ctx,
    );

    expect(result.success).toBe(true);
    const stdout = (result.data as Record<string, unknown>)['stdout'] as string;
    expect(stdout.length).toBeLessThanOrEqual(10);
  });

  // ── Concurrency counter leak prevention ─────────────────────────────────

  it('missing runtime config does not leak the concurrency counter', async () => {
    delete process.env['AGENT_RUNTIME_CONFIG_JSON'];
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    const first = await executeShellTool.execute({ command: 'echo test' }, ctx);
    expect(first.success).toBe(false);
    expect(first.errorCode).toBe('execute_shell.missing_runtime_policy');

    // Second call must not be blocked — the counter must still be at 0.
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = RUNTIME_CONFIG;
    const second = await executeShellTool.execute({ command: 'echo ok' }, ctx);
    expect(second.success).toBe(true);
    expect((second.data as Record<string, unknown>)['stdout']).toContain('ok');
  });

  it('restricted permission level does not leak the concurrency counter', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'restricted' });
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    const first = await executeShellTool.execute({ command: 'echo test' }, ctx);
    expect(first.success).toBe(false);
    expect(first.errorCode).toBe('execute_shell.permission_denied');

    // Restore full permission (works without agent user) and verify concurrency slot is free.
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });
    const second = await executeShellTool.execute({ command: 'echo ok' }, ctx);
    expect(second.success).toBe(true);
    expect((second.data as Record<string, unknown>)['stdout']).toContain('ok');
  });

  it('capability policy denial does not leak the concurrency counter', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: false, limits: { maxConcurrent: 1 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    const first = await executeShellTool.execute({ command: 'echo test' }, ctx);
    expect(first.success).toBe(false);
    expect(first.errorCode).toBe('capability.policy_denied');

    // Re-enable capability and verify counter is free.
    engine.replaceGrants([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
    ]);
    const second = await executeShellTool.execute({ command: 'echo ok' }, ctx);
    expect(second.success).toBe(true);
    expect((second.data as Record<string, unknown>)['stdout']).toContain('ok');
  });

  // ── Sandbox infrastructure error detection (mocked) ─────────────────────

  it('marks sandbox infrastructure failures as non-fault and non-retryable', async () => {
    vi.resetModules();

    try {
      const mockExec = vi.fn((
        _command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error('sandbox failed'), {
          code: 1,
          stdout: '',
          stderr: 'mount --make-shared /var/run/netns failed: Operation not permitted',
        });
        callback(error, '', error.stderr);
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => undefined),
        };
      });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'echo hello' },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.fault).toBe(false);
      expect(result.errorCode).toBe('execute_shell.sandbox_infrastructure_error');
      expect(result.error).toContain('Sandbox infrastructure error (non-recoverable)');
      expect(result.error).toContain('mount --make-shared');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('detects ip netns add sandbox infrastructure failure', async () => {
    vi.resetModules();

    try {
      const mockExec = vi.fn((
        _command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error('sandbox failed'), {
          code: 1,
          stdout: '',
          stderr: 'ip netns add sandbox-ns: Permission denied',
        });
        callback(error, '', error.stderr);
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => undefined),
        };
      });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'echo hello' },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('execute_shell.sandbox_infrastructure_error');
      expect(result.retryable).toBe(false);
      expect(result.fault).toBe(false);
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('does not misclassify ordinary permission stderr as sandbox infrastructure failure', async () => {
    vi.resetModules();

    try {
      const mockExec = vi.fn((
        _command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const error = Object.assign(new Error('script failed'), {
          code: 1,
          stdout: '',
          stderr: 'User script error: Permission denied while opening ./output.txt',
        });
        callback(error, '', error.stderr);
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => undefined),
        };
      });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'echo test' },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('execute_shell.execution_failed');
      expect(result.error).toBe('execute_shell failed with exit code 1');
      expect(result.fault).toBe(false);
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // ── Full mode sudo prefix (mocked) ─────────────────────────────────────

  it('full permission level runs command as root without sudo', async () => {
    vi.resetModules();

    try {
      let capturedCommand = '';
      const mockExec = vi.fn((
        command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedCommand = command;
        callback(null, 'full-output', '');
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          // No sandbox script present — test the raw command.
          access: vi.fn(async () => { throw new Error('ENOENT'); }),
        };
      });

      process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'whoami' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      expect(capturedCommand).not.toContain('sudo');
      expect(capturedCommand).toContain('sh -lc');
      expect(capturedCommand).toContain('whoami');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('standard permission level drops to agent user via sudo -u agent', async () => {
    vi.resetModules();

    try {
      let capturedCommand = '';
      const mockExec = vi.fn((
        command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedCommand = command;
        callback(null, 'standard-output', '');
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => { throw new Error('ENOENT'); }),
        };
      });

      process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'standard' });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'whoami' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      expect(capturedCommand).toContain('sudo -u agent');
      expect(capturedCommand).toContain('sh -lc');
      expect(capturedCommand).toContain('whoami');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('full mode with sandbox wraps root command inside sandbox-exec.sh', async () => {
    vi.resetModules();

    try {
      let capturedCommand = '';
      const mockExec = vi.fn((
        command: string,
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedCommand = command;
        callback(null, 'sandboxed-sudo-output', '');
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          // Sandbox exists
          access: vi.fn(async () => undefined),
        };
      });

      process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'ls -la' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      // Command should be: /usr/local/bin/sandbox-exec.sh sh -lc "ls -la"
      expect(capturedCommand).toContain('/usr/local/bin/sandbox-exec.sh');
      expect(capturedCommand).not.toContain('sudo');
      expect(capturedCommand).toContain('sh -lc');
      expect(capturedCommand).toContain('ls -la');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // ── Full mode working directory ─────────────────────────────────────────

  it('full mode allows absolute paths in workingDir', async () => {
    vi.resetModules();

    try {
      let capturedOptions: Record<string, unknown> = {};
      const mockExec = vi.fn((
        _command: string,
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedOptions = options;
        callback(null, 'full-cwd-output', '');
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => { throw new Error('ENOENT'); }),
        };
      });

      process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'ls', workingDir: '/tmp' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      expect(capturedOptions['cwd']).toBe('/tmp');
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('full mode resolves relative workingDir against workspace root', async () => {
    vi.resetModules();

    try {
      let capturedOptions: Record<string, unknown> = {};
      const mockExec = vi.fn((
        _command: string,
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        capturedOptions = options;
        callback(null, 'full-rel-output', '');
        return {};
      });

      vi.doMock('node:child_process', () => ({ exec: mockExec }));
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          access: vi.fn(async () => { throw new Error('ENOENT'); }),
        };
      });

      process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'full' });

      const { shellTools: freshShellTools } = await import('./shell.js');
      const freshExecuteShell = freshShellTools.find((tool) => tool.name === 'execute_shell');
      expect(freshExecuteShell).toBeDefined();

      const result = await freshExecuteShell!.execute(
        { command: 'ls', workingDir: 'subdir' },
        makeCtx(),
      );

      expect(result.success).toBe(true);
      expect(capturedOptions['cwd']).toBe(`${tempDir}/subdir`);
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // ── Description field in audit logging ──────────────────────────────────

  it('uses description field in audit logging inputSummary when provided', async () => {
    const recordEndSpy = vi.fn();
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true },
    ]);
    engine.recordEnd = recordEndSpy;
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeShellTool.execute(
      { command: 'echo test', description: 'List workspace files' },
      ctx,
    );

    expect(recordEndSpy).toHaveBeenCalledTimes(1);
    const auditRecord = recordEndSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(auditRecord['inputSummary']).toBe('List workspace files');
  });

  it('falls back to truncated command in audit logging when description is absent', async () => {
    const recordEndSpy = vi.fn();
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true },
    ]);
    engine.recordEnd = recordEndSpy;
    const ctx = makeCtx({ capabilityEngine: engine });

    const longCommand = 'echo ' + 'a'.repeat(200);
    await executeShellTool.execute(
      { command: longCommand },
      ctx,
    );

    expect(recordEndSpy).toHaveBeenCalledTimes(1);
    const auditRecord = recordEndSpy.mock.calls[0]![2] as Record<string, unknown>;
    const inputSummary = auditRecord['inputSummary'] as string;
    expect(inputSummary.length).toBeLessThanOrEqual(100);
    expect(inputSummary).toBe(longCommand.slice(0, 100));
  });

  it('records audit on success with correct fields', async () => {
    const recordStartSpy = vi.fn();
    const recordEndSpy = vi.fn();
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true },
    ]);
    engine.recordStart = recordStartSpy;
    engine.recordEnd = recordEndSpy;
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeShellTool.execute(
      { command: 'echo audit-test' },
      ctx,
    );

    expect(recordStartSpy).toHaveBeenCalledWith('execute_shell', 'session-1');
    expect(recordEndSpy).toHaveBeenCalledTimes(1);
    const auditRecord = recordEndSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(auditRecord['capability']).toBe('execute_shell');
    expect(auditRecord['agentId']).toBe('agent-1');
    expect(auditRecord['sessionId']).toBe('session-1');
    expect(auditRecord['success']).toBe(true);
    expect(typeof auditRecord['durationMs']).toBe('number');
    expect(typeof auditRecord['timestamp']).toBe('string');
  });

  it('records audit on failure with success:false', async () => {
    const recordEndSpy = vi.fn();
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true },
    ]);
    engine.recordEnd = recordEndSpy;
    const ctx = makeCtx({ capabilityEngine: engine });

    await executeShellTool.execute(
      { command: 'exit 1' },
      ctx,
    );

    expect(recordEndSpy).toHaveBeenCalledTimes(1);
    const auditRecord = recordEndSpy.mock.calls[0]![2] as Record<string, unknown>;
    expect(auditRecord['success']).toBe(false);
    expect(auditRecord['capability']).toBe('execute_shell');
  });

  // ── Permission level edge cases ─────────────────────────────────────────

  it('defaults to standard when AGENT_CONFIG has invalid JSON', async () => {
    process.env['AGENT_CONFIG'] = '{{invalid json';
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo fallback' },
      ctx,
    );

    // Should not be permission_denied (restricted); invalid JSON → standard
    expect(result.errorCode).not.toBe('execute_shell.permission_denied');
  });

  it('defaults to standard when AGENT_CONFIG has unknown permission level', async () => {
    process.env['AGENT_CONFIG'] = JSON.stringify({ permissionLevel: 'superadmin' });
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo fallback' },
      ctx,
    );

    // Unknown level → standard → allowed
    expect(result.errorCode).not.toBe('execute_shell.permission_denied');
  });

  // ── Kill switch ─────────────────────────────────────────────────────────

  it('enforces kill switch', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true },
    ]);
    engine.activateKillSwitch();
    const ctx = makeCtx({ capabilityEngine: engine });

    const result = await executeShellTool.execute(
      { command: 'echo test' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('capability.policy_denied');
    expect(result.error).toContain('suspended');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });

  // ── Concurrency enforcement ─────────────────────────────────────────────

  it('enforces maxConcurrent limit', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxConcurrent: 1, timeoutMs: 5_000 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    // Start a long-running command and a concurrent one
    const [first, second] = await Promise.all([
      executeShellTool.execute({ command: 'sleep 2' }, ctx),
      executeShellTool.execute({ command: 'echo concurrent' }, ctx),
    ]);

    // One of them must be denied with concurrency limit
    const results = [first, second];
    const denied = results.find((r) => r.errorCode === 'capability.policy_denied');
    expect(denied).toBeDefined();
    expect(denied!.retryable).toBe(true);
  });

  // ── CapabilityDenial string interpolation ─────────────────────────────────

  it('uses CapabilityDenial.message in the error string when rate limited', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: true, limits: { maxPerMinute: 1 } },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    const first = await executeShellTool.execute({ command: 'echo first' }, ctx);
    expect(first.success).toBe(true);

    const second = await executeShellTool.execute({ command: 'echo second' }, ctx);
    expect(second.success).toBe(false);
    expect(second.error).toContain('Rate limited');
    expect(second.error).not.toContain('[object Object]');
    expect(second.errorCode).toBe('capability.policy_denied');
    expect(second.retryable).toBe(true);
    expect(second.fault).toBe(false);
  });

  it('sets retryable=false for disabled capability denial', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_shell', tier: 'direct', enabled: false },
    ]);
    const ctx = makeCtx({ capabilityEngine: engine });

    const result = await executeShellTool.execute({ command: 'echo blocked' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('disabled');
    expect(result.error).not.toContain('[object Object]');
    expect(result.errorCode).toBe('capability.policy_denied');
    expect(result.retryable).toBe(false);
    expect(result.fault).toBe(false);
  });
});

// ── buildCapabilityGrants includes execute_shell ──────────────────────────

describe('buildCapabilityGrants', () => {
  it('includes execute_shell in DEFAULT_CAPABILITY_GRANTS', async () => {
    const { DEFAULT_CAPABILITY_GRANTS } = await import('../agents/capability-policy.js');
    const shellGrant = DEFAULT_CAPABILITY_GRANTS.find(
      (g: { capability: string }) => g.capability === 'execute_shell',
    );
    expect(shellGrant).toBeDefined();
    expect(shellGrant!.tier).toBe('direct');
    expect(shellGrant!.enabled).toBe(true);
    expect(shellGrant!.limits).toEqual({
      maxPerMinute: 10,
      maxConcurrent: 2,
      timeoutMs: 120_000,
      maxResponseBytes: 1024 * 1024,
    });
  });

  it('preserves execute_shell defaults when no overrides provided', async () => {
    const { buildCapabilityGrants } = await import('../agents/capability-policy.js');
    const grants = buildCapabilityGrants();
    const shellGrant = grants.find(
      (g: { capability: string }) => g.capability === 'execute_shell',
    );
    expect(shellGrant).toBeDefined();
    expect(shellGrant!.capability).toBe('execute_shell');
    expect(shellGrant!.tier).toBe('direct');
    expect(shellGrant!.enabled).toBe(true);
  });

  it('allows per-agent override of execute_shell limits', async () => {
    const { buildCapabilityGrants } = await import('../agents/capability-policy.js');
    const grants = buildCapabilityGrants({
      execute_shell: { tier: 'direct', enabled: true, limits: { maxPerMinute: 20 } },
    });
    const shellGrant = grants.find(
      (g: { capability: string }) => g.capability === 'execute_shell',
    );
    expect(shellGrant).toBeDefined();
    expect(shellGrant!.limits!.maxPerMinute).toBe(20);
    // Merged with defaults — other limit fields preserved
    expect(shellGrant!.limits!.maxConcurrent).toBe(2);
    expect(shellGrant!.limits!.timeoutMs).toBe(120_000);
  });

  it('allows disabling execute_shell via per-agent override', async () => {
    const { buildCapabilityGrants } = await import('../agents/capability-policy.js');
    const grants = buildCapabilityGrants({
      execute_shell: { tier: 'direct', enabled: false },
    });
    const shellGrant = grants.find(
      (g: { capability: string }) => g.capability === 'execute_shell',
    );
    expect(shellGrant).toBeDefined();
    expect(shellGrant!.enabled).toBe(false);
  });
});
