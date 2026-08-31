import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { shellTools } from './shell.js';

const executeShellTool = shellTools.find((t) => t.name === 'execute_shell')!;

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

describe('execute_shell stub', () => {
  it('is exported from shellTools', () => {
    expect(executeShellTool).toBeDefined();
  });

  it('has name execute_shell', () => {
    expect(executeShellTool.name).toBe('execute_shell');
  });

  it('has category execute-filesystem', () => {
    expect(executeShellTool.category).toBe('execute-filesystem');
  });

  it('returns not-implemented error for any input', async () => {
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo hello' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('tool.not_implemented');
    expect(result.retryable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns not-implemented error regardless of params', async () => {
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'ls -la', timeoutMs: 5000, workingDir: '/tmp' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('tool.not_implemented');
  });

  it('suggests using execute_code instead in the error message', async () => {
    const ctx = makeCtx();
    const result = await executeShellTool.execute(
      { command: 'echo test' },
      ctx,
    );

    expect(result.error).toContain('execute_code');
  });

  it('has a description mentioning permission levels', () => {
    expect(executeShellTool.description).toContain('permission level');
  });

  it('has a JSON parameters object for LLM function calling', () => {
    expect(executeShellTool.parameters).toBeDefined();
    expect(typeof executeShellTool.parameters).toBe('object');
  });
});
