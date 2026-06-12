import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { codeTools } from './code.js';
import { CapabilityPolicyEngine } from '../agents/capability-policy.js';
import * as workspaceModule from './workspace.js';
import type { ToolContext } from '@herobids/domain';

const executeCode = codeTools.find((t) => t.name === 'execute_code')!;

// Default runtime config for tests
const RUNTIME_CONFIG = JSON.stringify({
  tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 1_048_576 } },
});

function makeCtx(agentId = 'test-agent'): ToolContext {
  return {
    agentId,
    sessionId: 'session-1',
    phase: 'judge',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
  };
}

describe('execute_code tool', () => {
  let originalEnv: string | undefined;
  let originalWorkspaceRoot: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalEnv = process.env['AGENT_RUNTIME_CONFIG_JSON'];
    originalWorkspaceRoot = process.env['AGENT_WORKSPACE_ROOT'];
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = RUNTIME_CONFIG;
    tempDir = await mkdtemp(join(os.tmpdir(), 'herobids-code-test-'));
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

  it('executes JavaScript and returns structured output', async () => {
    const ctx = makeCtx();
    const result = await executeCode.execute(
      { code: 'console.log("hello from js")', language: 'javascript', dependencies: [] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('hello from js');
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(0);
    expect(typeof (result.data as Record<string, unknown>)['durationMs']).toBe('number');
  });

  it('executes Python and returns structured output', async () => {
    const ctx = makeCtx();
    const result = await executeCode.execute(
      { code: 'print("hello from python")', language: 'python', dependencies: [] },
      ctx,
    );

    // Skip if python3 is not available
    if (!result.success && String(result.error).includes('python3')) {
      return;
    }

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('hello from python');
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(0);
  });

  it('returns success:false with structured data on nonzero exit code', async () => {
    const ctx = makeCtx();
    const result = await executeCode.execute(
      { code: 'process.exit(2)', language: 'javascript', dependencies: [] },
      ctx,
    );

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(2);
    expect(typeof (result.data as Record<string, unknown>)['durationMs']).toBe('number');
  });

  it('truncates stdout to MAX_OUTPUT bytes', async () => {
    // Use a tiny output cap
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({
      tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 10 } },
    });

    const ctx = makeCtx();
    const result = await executeCode.execute(
      { code: 'console.log("a".repeat(100))', language: 'javascript', dependencies: [] },
      ctx,
    );

    expect(result.success).toBe(true);
    const stdout = (result.data as Record<string, unknown>)['stdout'] as string;
    expect(stdout.length).toBeLessThanOrEqual(10);
  });

  it('respects explicit timeoutMs', async () => {
    const ctx = makeCtx();
    const start = Date.now();
    const result = await executeCode.execute(
      {
        code: 'setTimeout(() => {}, 60000)',
        language: 'javascript',
        dependencies: [],
        timeoutMs: 1_000,
      },
      ctx,
    );
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // Should have timed out well before 10 seconds
    expect(elapsed).toBeLessThan(8_000);
  });

  it('workspace sandbox files persist between calls', async () => {
    const ctx = makeCtx();
    // First call writes a file
    await executeCode.execute(
      {
        code: `const fs = require('fs'); fs.writeFileSync(process.env.AGENT_WORKSPACE_ROOT + '/output.txt', 'persisted');`,
        language: 'javascript',
        dependencies: [],
      },
      ctx,
    );

    // Second call reads it back
    const result = await executeCode.execute(
      {
        code: `const fs = require('fs'); console.log(fs.readFileSync(process.env.AGENT_WORKSPACE_ROOT + '/output.txt', 'utf8'));`,
        language: 'javascript',
        dependencies: [],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('persisted');
  });

  it('rejects invalid dependency names', async () => {
    const ctx = makeCtx();
    const result = await executeCode.execute(
      {
        code: 'console.log("ok")',
        language: 'javascript',
        dependencies: ['../evil; rm -rf /'],
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid dependency names/);
  });

  it('JavaScript dependency install path installs and uses the package', async () => {
    // Allow extra time for npm install to download the package
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({
      tools: { codeExecute: { defaultTimeoutMs: 45_000, defaultMaxOutputBytes: 1_048_576 } },
    });
    const ctx = makeCtx();
    const result = await executeCode.execute(
      {
        // ms is a tiny package that converts milliseconds
        code: 'const ms = require("ms"); console.log(ms(1000));',
        language: 'javascript',
        dependencies: ['ms'],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('1s');
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(0);
  }, 60_000);

  it('Python dependency install path installs and uses the package', async () => {
    // Allow extra time for pip install to download the package
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({
      tools: { codeExecute: { defaultTimeoutMs: 45_000, defaultMaxOutputBytes: 1_048_576 } },
    });
    const ctx = makeCtx();
    const result = await executeCode.execute(
      {
        // python-dateutil is a small, widely available package
        code: 'from dateutil.parser import parse; print(parse("2000-01-01").year)',
        language: 'python',
        dependencies: ['python-dateutil'],
      },
      ctx,
    );

    // Skip if python3 or pip is not available on this machine
    if (!result.success) {
      const dataStdout = String((result.data as Record<string, unknown> | undefined)?.['stdout'] ?? '');
      const dataStderr = String((result.data as Record<string, unknown> | undefined)?.['stderr'] ?? '');
      const allOutput = dataStdout + dataStderr + String(result.error ?? '');
      if (allOutput.includes('python3') || allOutput.includes('pip')) {
        return;
      }
    }

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('2000');
    expect((result.data as Record<string, unknown>)['exitCode']).toBe(0);
  }, 60_000);

  it('stderr is captured and truncated for code that writes to stderr', async () => {
    process.env['AGENT_RUNTIME_CONFIG_JSON'] = JSON.stringify({
      tools: { codeExecute: { defaultTimeoutMs: 10_000, defaultMaxOutputBytes: 1_048_576 } },
    });

    const ctx = makeCtx();
    const result = await executeCode.execute(
      {
        // Write a large amount to stderr and a small amount to stdout
        code: `process.stderr.write('e'.repeat(20000)); console.log('done');`,
        language: 'javascript',
        dependencies: [],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const stderr = (result.data as Record<string, unknown>)['stderr'] as string;
    // stderr is capped at 10 KiB (10 * 1024 bytes)
    expect(stderr.length).toBeLessThanOrEqual(10 * 1024);
    expect((result.data as Record<string, unknown>)['stdout']).toContain('done');
  });

  it('invalid dependency name does not leak the concurrency counter', async () => {
    // Construct an engine with maxConcurrent: 1.  If recordStart were called
    // before dep validation, the counter would stay at 1 after the first call
    // and the second call would be denied with max_concurrent_exceeded.
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
    ]);
    const ctx = { ...makeCtx(), capabilityEngine: engine };

    const first = await executeCode.execute(
      { code: 'console.log("ok")', language: 'javascript', dependencies: ['../evil; rm -rf /'] },
      ctx,
    );
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/invalid dependency names/);

    // Second call must not be blocked — the counter must still be at 0.
    const second = await executeCode.execute(
      { code: 'console.log("second")', language: 'javascript', dependencies: [] },
      ctx,
    );
    expect(second.success).toBe(true);
    expect((second.data as Record<string, unknown>)['stdout']).toContain('second');
  });

  it('sandbox setup failure does not leak the concurrency counter', async () => {
    const engine = new CapabilityPolicyEngine([
      { capability: 'execute_code', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
    ]);
    const ctx = { ...makeCtx(), capabilityEngine: engine };
    const ensureWorkspaceDirsSpy = vi
      .spyOn(workspaceModule, 'ensureWorkspaceDirs')
      .mockRejectedValueOnce(new Error('workspace unavailable'));

    const first = await executeCode.execute(
      { code: 'console.log("ok")', language: 'javascript', dependencies: [] },
      ctx,
    );
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/failed with exit code/);

    ensureWorkspaceDirsSpy.mockRestore();

    const second = await executeCode.execute(
      { code: 'console.log("second")', language: 'javascript', dependencies: [] },
      ctx,
    );
    expect(second.success).toBe(true);
    expect((second.data as Record<string, unknown>)['stdout']).toContain('second');
  });

  it('sandbox is cleaned between invocations — prior artifacts do not bleed through', async () => {
    const ctx = makeCtx();

    // First invocation: write a sentinel file into the sandbox directory.
    const firstResult = await executeCode.execute(
      {
        code: `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(__dirname, 'leftover.txt'), 'from first run');
console.log('wrote');
`,
        language: 'javascript',
        dependencies: [],
      },
      ctx,
    );
    expect(firstResult.success).toBe(true);

    // Second invocation: check whether the sentinel file still exists.
    // After the fix the sandbox is wiped before each run, so it must not be there.
    const secondResult = await executeCode.execute(
      {
        code: `
const fs = require('fs');
const path = require('path');
const exists = fs.existsSync(path.join(__dirname, 'leftover.txt'));
console.log(exists ? 'found' : 'not found');
`,
        language: 'javascript',
        dependencies: [],
      },
      ctx,
    );
    expect(secondResult.success).toBe(true);
    expect((secondResult.data as Record<string, unknown>)['stdout']).toContain('not found');
  });
});
