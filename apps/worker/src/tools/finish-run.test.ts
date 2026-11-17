import { describe, expect, it, vi } from 'vitest';
import { isReadOnlyCategory, type ToolContext } from '@herobids/domain';
import { DURABLE_TOOL_NAMES } from '../structured-tool-loop.js';
import { FINISH_RUN_REASON_MAX_LENGTH } from '@herobids/domain';
import { finishRunTool } from './finish-run.js';
import { createToolRegistry } from './index.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
  };
}

describe('finish_run tool', () => {
  it.each(['complete', 'waiting', 'blocked'])('acknowledges status %s', async (status) => {
    const parsed = finishRunTool.parametersSchema.parse({ status, reason: 'done for now' });
    const result = await finishRunTool.execute(parsed, makeCtx());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ok: true, status });
  });

  it('rejects an unknown status', async () => {
    const result = await finishRunTool.execute({ status: 'finished', reason: 'x' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid finish_run parameters');
  });

  it('rejects an empty reason', async () => {
    const result = await finishRunTool.execute({ status: 'complete', reason: '' }, makeCtx());

    expect(result.success).toBe(false);
  });

  it('accepts a reason of exactly the maximum length and rejects one character more', async () => {
    const ok = await finishRunTool.execute({ status: 'complete', reason: 'a'.repeat(FINISH_RUN_REASON_MAX_LENGTH) }, makeCtx());
    const tooLong = await finishRunTool.execute({ status: 'complete', reason: 'a'.repeat(FINISH_RUN_REASON_MAX_LENGTH + 1) }, makeCtx());

    expect(FINISH_RUN_REASON_MAX_LENGTH).toBe(300);
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });

  it('rejects a missing reason', async () => {
    const result = await finishRunTool.execute({ status: 'waiting' }, makeCtx());

    expect(result.success).toBe(false);
  });

  it('is refused in scout because it is not in the read-only tool list', () => {
    expect(isReadOnlyCategory(finishRunTool.category)).toBe(false);
    expect(createToolRegistry().getReadOnlyToolNames()).not.toContain('finish_run');
  });

  it('is not kept as a durable tool result', () => {
    expect(DURABLE_TOOL_NAMES.has('finish_run')).toBe(false);
  });

  it('declares status and reason as required parameters with a status enum', () => {
    const schema = finishRunTool.parameters as { required?: string[]; properties?: Record<string, { enum?: string[] }> };

    expect([...(schema.required ?? [])].sort()).toEqual(['reason', 'status']);
    expect(schema.properties?.['status']?.enum).toEqual(['complete', 'waiting', 'blocked']);
  });
});
