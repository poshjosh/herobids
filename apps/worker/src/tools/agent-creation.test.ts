import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import type { AgentPlatformError, AgentPlatformPort, ToolContext } from '@herobids/domain';
import {
  agentCreationTools,
  isCreateAgentExposed,
  isCreatorToolExposed,
} from './agent-creation.js';

const createAgentTool = agentCreationTools.find((t) => t.name === 'create_agent')!;
const pauseChildTool = agentCreationTools.find((t) => t.name === 'pause_child_agent')!;

function allowance(childAgentLimit: number, childCount: number) {
  return {
    id: 'agent-1',
    childAgentLimit,
    childCount,
    remainingChildAllowance: Math.max(0, childAgentLimit - childCount),
  };
}

function fakePlatform(overrides: Partial<AgentPlatformPort> = {}): AgentPlatformPort {
  return {
    getOwnAllowance: vi.fn(async () => ok(allowance(2, 0))),
    createChildAgent: vi.fn(async () => ok({ id: 'child-1', depth: 1 })),
    getChildStatus: vi.fn(async () => err(platformError('agent.platform.not_found', false))),
    pauseChildAgent: vi.fn(async () => ok({ status: 'paused' })),
    stopChildAgent: vi.fn(async () => ok({ status: 'stopped' })),
    messageChildAgent: vi.fn(async () => ok({ delivered: true })),
    ...overrides,
  };
}

function platformError(code: string, retryable: boolean): AgentPlatformError {
  return { code, message: 'fixed message', retryable };
}

function makeCtx(agentPlatform?: AgentPlatformPort): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'judge',
    executionMode: 'paper',
    permissionLevel: 'standard',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      hgetall: vi.fn(async () => null),
      hdel: vi.fn(async () => 0),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...(agentPlatform ? { agentPlatform } : {}),
  };
}

describe('create_agent exposure', () => {
  it('create_agent is not exposed when the child allowance limit is zero', () => {
    expect(isCreateAgentExposed(allowance(0, 0))).toBe(false);
  });

  it('create_agent is not exposed once direct children reach the limit', () => {
    expect(isCreateAgentExposed(allowance(2, 2))).toBe(false);
  });

  it('create_agent is exposed while direct children are under the limit', () => {
    expect(isCreateAgentExposed(allowance(2, 1))).toBe(true);
  });

  it('create_agent is hidden when the allowance is unknown', () => {
    expect(isCreateAgentExposed(null)).toBe(false);
  });
});

describe('creator tool exposure', () => {
  it('creator tools are hidden when the agent has no direct children', () => {
    expect(isCreatorToolExposed(allowance(2, 0))).toBe(false);
  });

  it('creator tools are exposed when the agent has at least one direct child', () => {
    expect(isCreatorToolExposed(allowance(2, 1))).toBe(true);
  });

  it('creator tools are hidden when the allowance is unknown', () => {
    expect(isCreatorToolExposed(null)).toBe(false);
  });
});

describe('create_agent input schema', () => {
  it('create_agent input rejects creatorId, parentAgentId and depth', () => {
    for (const field of ['creatorId', 'parentAgentId', 'depth']) {
      const result = createAgentTool.parametersSchema.safeParse({
        name: 'Research child',
        prompt: 'Summarise the market.',
        [field]: 'smuggled',
      });
      expect(result.success, `${field} must be refused`).toBe(false);
    }
  });

  it('create_agent input accepts name, prompt, skillIds and connectionIds', () => {
    const result = createAgentTool.parametersSchema.safeParse({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
      connectionIds: ['conn-1'],
    });
    expect(result.success).toBe(true);
  });
});

describe('create_agent execution', () => {
  it('create_agent reports the new agent with the remaining child allowance', async () => {
    const platform = fakePlatform({
      getOwnAllowance: vi.fn(async () => ok(allowance(3, 1))),
    });
    const result = await createAgentTool.execute(
      { name: 'Research child', prompt: 'Summarise the market.' },
      makeCtx(platform),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      agentId: 'child-1',
      depth: 1,
      childAgentLimit: 3,
      remainingChildAllowance: 2,
    });
  });

  it('a refused platform call returns the namespaced code from the platform client', async () => {
    const platform = fakePlatform({
      createChildAgent: vi.fn(async () => err(platformError('agent.create.allowance_exhausted', false))),
    });
    const result = await createAgentTool.execute(
      { name: 'Research child', prompt: 'Summarise the market.' },
      makeCtx(platform),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('agent.create.allowance_exhausted');
    expect(result.retryable).toBe(false);
  });

  it('a timeout from the platform maps to a retryable tool error', async () => {
    const platform = fakePlatform({
      pauseChildAgent: vi.fn(async () => err(platformError('agent.platform.timeout', true))),
    });
    const result = await pauseChildTool.execute({ agentId: 'child-1' }, makeCtx(platform));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('agent.platform.timeout');
    expect(result.retryable).toBe(true);
  });

  it('a tool call without a configured platform returns a not-configured error', async () => {
    const result = await createAgentTool.execute(
      { name: 'Research child', prompt: 'Summarise the market.' },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('agent.platform.not_configured');
  });
});
