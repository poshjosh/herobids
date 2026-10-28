import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { addSkillsTool } from './skills.js';

function makeCtx(): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
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
  };
}

describe('add_skills refuses the user-only children skill', () => {
  it.each([
    ['the id', 'child-agent-management'],
    ['the system slug', 'system/child-agent-management'],
  ])('refuses %s for an agent caller and never reaches the broker', async (_label, skill) => {
    const ctx = makeCtx();
    const result = await addSkillsTool.execute({ skillIds: [skill] }, ctx);

    expect(result).toMatchObject({
      success: false,
      error: 'This skill can only be added by the user.',
      errorCode: 'skill.user_only',
    });
    expect(ctx.publishToInbound).not.toHaveBeenCalled();
  });

  it('refuses the whole call when the user-only skill is mixed with an allowed one', async () => {
    const ctx = makeCtx();
    const result = await addSkillsTool.execute({ skillIds: ['system/browser', 'child-agent-management'] }, ctx);

    expect(result).toMatchObject({ success: false, errorCode: 'skill.user_only' });
    expect(ctx.publishToInbound).not.toHaveBeenCalled();
  });
});
