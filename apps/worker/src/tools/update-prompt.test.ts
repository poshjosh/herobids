import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { updateMyPromptTool } from './update-prompt.js';

function makeCtx(blpopReply: [string, string] | null) {
  const publishToInbound = vi.fn(async () => undefined);
  const blpop = vi.fn(async () => blpopReply);
  const ctx = {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: { blpop } as unknown as ToolContext['redis'],
    publishToInbound,
  } as unknown as ToolContext;
  return { ctx, publishToInbound, blpop };
}

describe('update_my_prompt tool', () => {
  it('rejects an empty prompt without contacting the broker', async () => {
    const { ctx, publishToInbound } = makeCtx(null);
    const result = await updateMyPromptTool.execute({ prompt: '' }, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'validation.invalid_payload' });
    expect(publishToInbound).not.toHaveBeenCalled();
  });

  it('sends agent.update_prompt and confirms the new goal applies next run', async () => {
    const { ctx, publishToInbound, blpop } = makeCtx(['key', JSON.stringify({ status: 'ok', promptLength: 12 })]);
    const result = await updateMyPromptTool.execute({ prompt: 'Watch ETH.' }, ctx);

    expect(publishToInbound).toHaveBeenCalledWith(
      'agent.update_prompt',
      expect.objectContaining({ prompt: 'Watch ETH.', requestMessageId: expect.any(String) }),
    );
    expect(blpop).toHaveBeenCalledWith(expect.stringMatching(/^agent:update-prompt:reply:/), 15);
    expect(result).toMatchObject({ success: true, data: { ok: true, promptLength: 12 } });
  });

  it('returns a broker error with its code', async () => {
    const { ctx } = makeCtx(['key', JSON.stringify({ status: 'error', error: 'Agent not found', errorCode: 'agent.not_found' })]);
    const result = await updateMyPromptTool.execute({ prompt: 'Watch ETH.' }, ctx);

    expect(result).toEqual({ success: false, error: 'Agent not found', errorCode: 'agent.not_found', fault: false });
  });
});
