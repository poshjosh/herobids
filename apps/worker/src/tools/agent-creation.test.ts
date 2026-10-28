import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import type { AgentPlatformError, AgentPlatformPort, AgentTool, ToolContext } from '@herobids/domain';
import {
  agentCreationTools,
  CREATOR_TOOL_NAMES,
  isCreateChildAgentExposed,
  isCreatorToolExposed,
} from './agent-creation.js';

const createAgentTool = agentCreationTools.find((t) => t.name === 'create_child_agent')!;
const pauseChildTool = agentCreationTools.find((t) => t.name === 'pause_child_agent')!;
const listChildAgentsTool = agentCreationTools.find((t) => t.name === 'list_child_agents')!;
const deleteChildAgentTool = agentCreationTools.find((t) => t.name === 'delete_child_agent')!;

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
    createChildAgent: vi.fn(async () => ok({ id: 'child-1', depth: 1, status: 'starting', duplicate: false, started: true, startError: null })),
    getChildStatus: vi.fn(async () => err(platformError('agent.platform.not_found', false))),
    pauseChildAgent: vi.fn(async () => ok({ status: 'paused' })),
    stopChildAgent: vi.fn(async () => ok({ status: 'stopped' })),
    messageChildAgent: vi.fn(async () => ok({ delivered: true })),
    listChildAgents: vi.fn(async () => ok([])),
    deleteChildAgent: vi.fn(async () => ok({ deleted: true as const, stopped: false })),
    readAgentDocument: vi.fn(async () => err(platformError('agent.platform.not_found', false))),
    ...overrides,
  };
}

function platformError(code: string, retryable: boolean): AgentPlatformError {
  return { code, message: 'fixed message', retryable };
}

interface JsonSchemaArm { type?: string; default?: unknown }
interface JsonSchemaProperty extends JsonSchemaArm { anyOf?: JsonSchemaArm[] }
interface JsonSchemaObject { required?: string[]; properties: Record<string, JsonSchemaProperty> }

/** The schema arms of one property. An optional boolean is wrapped in anyOf with a null arm by the converter. */
function booleanArms(schema: JsonSchemaObject, name: string): JsonSchemaArm[] {
  const property = schema.properties[name];
  return property?.anyOf ?? (property ? [property] : []);
}

/** Runs the tool's schema the way the agent runtime does before execute, so defaults such as start apply. */
function parsedInput(tool: AgentTool, params: Record<string, unknown>): unknown {
  const result = tool.parametersSchema.safeParse(params);
  if (!result.success) throw new Error(`fixture does not parse: ${result.error.message}`);
  return result.data;
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

describe('create_child_agent exposure', () => {
  it('create_child_agent is not exposed when the child allowance limit is zero', () => {
    expect(isCreateChildAgentExposed(allowance(0, 0))).toBe(false);
  });

  it('create_child_agent is not exposed once direct children reach the limit', () => {
    expect(isCreateChildAgentExposed(allowance(2, 2))).toBe(false);
  });

  it('create_child_agent is exposed while direct children are under the limit', () => {
    expect(isCreateChildAgentExposed(allowance(2, 1))).toBe(true);
  });

  it('create_child_agent is hidden when the allowance is unknown', () => {
    expect(isCreateChildAgentExposed(null)).toBe(false);
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

describe('create_child_agent input schema', () => {
  it('create_child_agent input rejects creatorId, parentAgentId and depth', () => {
    for (const field of ['creatorId', 'parentAgentId', 'depth']) {
      const result = createAgentTool.parametersSchema.safeParse({
        name: 'Research child',
        prompt: 'Summarise the market.',
        [field]: 'smuggled',
      });
      expect(result.success, `${field} must be refused`).toBe(false);
    }
  });

  it('create_child_agent input accepts name, prompt, skillIds and connectionIds', () => {
    const result = createAgentTool.parametersSchema.safeParse({
      name: 'Research child',
      prompt: 'Summarise the market.',
      skillIds: ['skill-1'],
      connectionIds: ['conn-1'],
    });
    expect(result.success).toBe(true);
  });

  it('start defaults to true when omitted', () => {
    const result = createAgentTool.parametersSchema.parse({ name: 'Research child', prompt: 'Summarise the market.' });
    expect(result.start).toBe(true);
  });

  it('start accepts false and refuses a non-boolean value', () => {
    expect(createAgentTool.parametersSchema.parse({ name: 'c', prompt: 'p', start: false }).start).toBe(false);
    expect(createAgentTool.parametersSchema.safeParse({ name: 'c', prompt: 'p', start: 'no' }).success).toBe(false);
  });

  it('start is optional in the JSON schema the model sees, and documents its default', () => {
    const schema = createAgentTool.parameters as JsonSchemaObject;
    expect(schema.required ?? []).not.toContain('start');
    expect(booleanArms(schema, 'start')).toContainEqual(expect.objectContaining({ type: 'boolean', default: true }));
  });
});

describe('create_child_agent execution', () => {
  it('starts the child by default, and the result reports it started', async () => {
    const platform = fakePlatform();
    const result = await createAgentTool.execute(
      parsedInput(createAgentTool, { name: 'Research child', prompt: 'Summarise the market.' }),
      makeCtx(platform),
    );

    expect(platform.createChildAgent).toHaveBeenCalledWith(expect.objectContaining({ start: true }));
    expect(result).toMatchObject({ success: true, data: { started: true, startError: null } });
  });

  it('start false creates the child stopped, and the result says so', async () => {
    const platform = fakePlatform({
      createChildAgent: vi.fn(async () => ok({ id: 'child-1', depth: 1, status: 'stopped', duplicate: false, started: false, startError: null })),
    });
    const result = await createAgentTool.execute(
      parsedInput(createAgentTool, { name: 'Research child', prompt: 'Summarise the market.', start: false }),
      makeCtx(platform),
    );

    expect(platform.createChildAgent).toHaveBeenCalledWith(expect.objectContaining({ start: false }));
    expect(result).toMatchObject({ success: true, data: { started: false, startError: null } });
    expect(result.data).toMatchObject({ note: expect.stringContaining('stopped') });
  });

  it('a same-name retry inside the window returns the existing child as a duplicate, and nothing is started', async () => {
    const platform = fakePlatform({
      createChildAgent: vi.fn(async () => ok({ id: 'child-1', depth: 1, status: 'stopped', duplicate: true, started: false, startError: null })),
    });
    const result = await createAgentTool.execute(
      parsedInput(createAgentTool, { name: 'Research child', prompt: 'Summarise the market.' }),
      makeCtx(platform),
    );

    expect(result).toMatchObject({
      success: true,
      data: { ok: true, agentId: 'child-1', status: 'stopped', duplicate: true, started: false, startError: null },
    });
    expect(JSON.stringify(result)).toContain('not started again');
  });

  it('a refused start keeps the child created, and the result gives the reason', async () => {
    const platform = fakePlatform({
      createChildAgent: vi.fn(async () => ok({
        id: 'child-1',
        depth: 1,
        status: 'stopped',
        duplicate: false,
        started: false,
        startError: { code: 'agent.model_selection_incomplete', message: 'Agent cannot start — set provider, lightModel, and heavyModel.' },
      })),
    });
    const result = await createAgentTool.execute(
      parsedInput(createAgentTool, { name: 'Research child', prompt: 'Summarise the market.' }),
      makeCtx(platform),
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        agentId: 'child-1',
        started: false,
        startError: { code: 'agent.model_selection_incomplete', message: 'Agent cannot start — set provider, lightModel, and heavyModel.' },
      },
    });
  });

  it('create_child_agent reports the new agent with the remaining child allowance', async () => {
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

describe('create_child_agent refuses the user-only children skill', () => {
  it.each([['child-agent-management'], ['system/child-agent-management']])('refuses to grant %s to a child', async (skill) => {
    const platform = fakePlatform();
    const result = await createAgentTool.execute(
      { name: 'Child', prompt: 'Do work.', skillIds: [skill] },
      makeCtx(platform),
    );

    expect(result).toMatchObject({ success: false, error: 'This skill can only be added by the user.', errorCode: 'skill.user_only' });
    expect(platform.createChildAgent).not.toHaveBeenCalled();
  });
});

describe('list_child_agents', () => {
  it('is read-only and takes no parameters', () => {
    expect(listChildAgentsTool.category).toBe('read-database');
    expect(listChildAgentsTool.parametersSchema.safeParse({ extra: true }).success).toBe(false);
    expect(listChildAgentsTool.parametersSchema.safeParse({}).success).toBe(true);
  });

  it('is not one of the creator tools, so it is not gated on having a child', () => {
    expect(CREATOR_TOOL_NAMES).not.toContain('list_child_agents');
  });

  it('returns an empty list with count 0 when the agent has no children', async () => {
    const platform = fakePlatform({ listChildAgents: vi.fn(async () => ok([])) });
    const result = await listChildAgentsTool.execute({}, makeCtx(platform));

    expect(result).toEqual({ success: true, data: { ok: true, count: 0, children: [] } });
  });

  it('returns the last start refusal of each direct child, null when none', async () => {
    const refusal = { code: 'billing.insufficient_funds', message: 'Insufficient billing credit — agent session start blocked', at: '2026-10-26T10:00:00.000Z' };
    const children = [
      { id: 'child-1', name: 'Research', status: 'stopped', depth: 1, childCount: 0, lastStartRefusal: refusal },
      { id: 'child-2', name: 'Trader', status: 'active', depth: 1, childCount: 0, lastStartRefusal: null },
    ];
    const platform = fakePlatform({ listChildAgents: vi.fn(async () => ok(children)) });
    const result = await listChildAgentsTool.execute({}, makeCtx(platform));

    expect(result).toEqual({ success: true, data: { ok: true, count: 2, children } });
  });

  it('returns each direct child with its id, name, status and child count', async () => {
    const children = [{ id: 'child-1', name: 'Research', status: 'stopped', depth: 1, childCount: 0, lastStartRefusal: null }];
    const platform = fakePlatform({ listChildAgents: vi.fn(async () => ok(children)) });
    const result = await listChildAgentsTool.execute({}, makeCtx(platform));

    expect(result).toEqual({ success: true, data: { ok: true, count: 1, children } });
  });

  it('reports the platform failure without a child list', async () => {
    const platform = fakePlatform({ listChildAgents: vi.fn(async () => err(platformError('agent.platform.unavailable', true))) });
    const result = await listChildAgentsTool.execute({}, makeCtx(platform));

    expect(result).toMatchObject({ success: false, errorCode: 'agent.platform.unavailable', retryable: true });
  });
});

describe('delete_child_agent', () => {
  it('is a creator tool, so it is gated on the agent having a child', () => {
    expect(CREATOR_TOOL_NAMES).toContain('delete_child_agent');
    expect(isCreatorToolExposed(allowance(2, 0))).toBe(false);
    expect(isCreatorToolExposed(allowance(2, 1))).toBe(true);
  });

  it('stopFirst defaults to true when omitted', () => {
    const result = deleteChildAgentTool.parametersSchema.parse({ agentId: 'child-1' });
    expect(result).toMatchObject({ agentId: 'child-1', stopFirst: true });
  });

  it('stopFirst is optional in the JSON schema the model sees, and documents its default', () => {
    const schema = deleteChildAgentTool.parameters as JsonSchemaObject;
    expect(schema.required ?? []).not.toContain('stopFirst');
    expect(booleanArms(schema, 'stopFirst')).toContainEqual(expect.objectContaining({ type: 'boolean', default: true }));
  });

  it('deletes a running child by default: the platform is asked to stop it first, and the result says so', async () => {
    const platform = fakePlatform({
      deleteChildAgent: vi.fn(async () => ok({ deleted: true as const, stopped: true })),
    });
    const result = await deleteChildAgentTool.execute(parsedInput(deleteChildAgentTool, { agentId: 'child-1' }), makeCtx(platform));

    expect(platform.deleteChildAgent).toHaveBeenCalledWith('child-1', true);
    expect(result).toEqual({ success: true, data: { ok: true, agentId: 'child-1', deleted: true, stopped: true } });
  });

  it('deletes a stopped child by default, without reporting a stop', async () => {
    const platform = fakePlatform();
    const result = await deleteChildAgentTool.execute(parsedInput(deleteChildAgentTool, { agentId: 'child-1', stopFirst: true }), makeCtx(platform));

    expect(platform.deleteChildAgent).toHaveBeenCalledWith('child-1', true);
    expect(result).toEqual({ success: true, data: { ok: true, agentId: 'child-1', deleted: true, stopped: false } });
  });

  it('stopFirst false on a running child is refused with the stop-first message, and nothing is deleted', async () => {
    const platform = fakePlatform({
      deleteChildAgent: vi.fn(async () => err(platformError('agent.child.running', false))),
    });
    const result = await deleteChildAgentTool.execute(parsedInput(deleteChildAgentTool, { agentId: 'child-1', stopFirst: false }), makeCtx(platform));

    expect(platform.deleteChildAgent).toHaveBeenCalledWith('child-1', false);
    expect(result).toMatchObject({
      success: false,
      error: 'child is running; stop it first or pass stopFirst: true',
      errorCode: 'agent.child.running',
      retryable: false,
    });
  });

  it('a child that is not the agent\'s own is refused by the platform, and the tool reports that refusal', async () => {
    const platform = fakePlatform({
      deleteChildAgent: vi.fn(async () => err(platformError('agent.platform.forbidden', false))),
    });
    const result = await deleteChildAgentTool.execute(parsedInput(deleteChildAgentTool, { agentId: 'someone-else' }), makeCtx(platform));

    expect(platform.deleteChildAgent).toHaveBeenCalledWith('someone-else', true);
    expect(result).toMatchObject({ success: false, errorCode: 'agent.platform.forbidden' });
  });

  it('explains a child that still has children of its own', async () => {
    const platform = fakePlatform({
      deleteChildAgent: vi.fn(async () => err(platformError('agent.child.has_children', false))),
    });
    const result = await deleteChildAgentTool.execute(parsedInput(deleteChildAgentTool, { agentId: 'child-1' }), makeCtx(platform));

    expect(result).toMatchObject({
      success: false,
      error: 'This child agent has children of its own. Ask the user to delete it.',
      errorCode: 'agent.child.has_children',
    });
  });

  it('rejects unknown parameters such as a parent id', () => {
    expect(deleteChildAgentTool.parametersSchema.safeParse({ agentId: 'child-1', parentAgentId: 'x' }).success).toBe(false);
  });
});
