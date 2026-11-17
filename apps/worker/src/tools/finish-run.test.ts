import { describe, expect, it, vi } from 'vitest';
import { isReadOnlyCategory, type ToolContext } from '@herobids/domain';
import { DURABLE_TOOL_NAMES } from '../structured-tool-loop.js';
import { FINISH_RUN_REASON_MAX_LENGTH } from '@herobids/domain';
import { finishRunTool, normalizeFinishRun } from './finish-run.js';
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

  it('records complete with the reason "Done" when called with no arguments', async () => {
    const parsed = finishRunTool.parametersSchema.parse({});
    const result = await finishRunTool.execute(parsed, makeCtx());

    expect(normalizeFinishRun(parsed)).toEqual({ status: 'complete', reason: 'Done' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ok: true, status: 'complete' });
  });

  it('treats null arguments as missing', async () => {
    const result = await finishRunTool.execute({ status: null, reason: null }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ok: true, status: 'complete' });
  });

  it('uses the reason "Done" when the reason is blank', () => {
    expect(normalizeFinishRun(finishRunTool.parametersSchema.parse({ status: 'waiting', reason: '   ' }))).toEqual({ status: 'waiting', reason: 'Done' });
  });

  it('defaults the status to complete when only a reason is given', () => {
    expect(normalizeFinishRun(finishRunTool.parametersSchema.parse({ reason: 'all sent' }))).toEqual({ status: 'complete', reason: 'all sent' });
  });

  it('accepts a reason of exactly the maximum length and rejects one character more', async () => {
    const ok = await finishRunTool.execute({ status: 'complete', reason: 'a'.repeat(FINISH_RUN_REASON_MAX_LENGTH) }, makeCtx());
    const tooLong = await finishRunTool.execute({ status: 'complete', reason: 'a'.repeat(FINISH_RUN_REASON_MAX_LENGTH + 1) }, makeCtx());

    expect(FINISH_RUN_REASON_MAX_LENGTH).toBe(300);
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });

  it('keeps waiting with the default reason when the reason is missing', () => {
    expect(normalizeFinishRun(finishRunTool.parametersSchema.parse({ status: 'waiting' }))).toEqual({ status: 'waiting', reason: 'Done' });
  });

  it('is refused in scout because it is not in the read-only tool list', () => {
    expect(isReadOnlyCategory(finishRunTool.category)).toBe(false);
    expect(createToolRegistry().getReadOnlyToolNames()).not.toContain('finish_run');
  });

  it('is not kept as a durable tool result', () => {
    expect(DURABLE_TOOL_NAMES.has('finish_run')).toBe(false);
  });

  it('declares no required parameters and a status enum', () => {
    const schema = finishRunTool.parameters as { required?: string[]; properties?: Record<string, unknown> };

    expect(schema.required ?? []).toEqual([]);
    expect(JSON.stringify(schema.properties?.['status'])).toContain('"enum":["complete","waiting","blocked"]');
  });
});
