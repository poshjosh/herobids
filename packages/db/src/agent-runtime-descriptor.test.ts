import { describe, expect, it, vi } from 'vitest';
import type { Database } from './index.js';
import { resolveRuntimeCapabilityDescriptor } from './agent-runtime-descriptor.js';

function makeChain(value: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (v: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
}

function createSkillRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'custom-skill',
    authorId: 'user-1',
    name: 'Custom Skill',
    description: 'Custom instructions',
    instructions: 'Do the custom thing',
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: [],
    suggestedTickIntervalMs: 900_000,
    visibility: 'private',
    tags: [],
    forkOf: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('resolveRuntimeCapabilityDescriptor', () => {
  it('resolves the built-in programming skill with execute_code', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain([]);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1', ['programming']);

    expect(descriptor.resolvedSkills.map((skill) => skill.id)).toEqual(['base', 'programming']);
    expect(descriptor.resolvedSkills[1]?.requiredTools).toEqual(['execute_code', 'send_message', 'publish_artifact']);
  });

  it('fails loudly for unknown required tools in stored skill rows', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [createSkillRow({ id: 'invalid-skill', requiredTools: ['totally_unknown_tool'] })]
          : []);
      }),
    } as unknown as Database;

    await expect(resolveRuntimeCapabilityDescriptor(db, 'agent-1', ['invalid-skill']))
      .rejects
      .toThrow('Skill invalid-skill references unknown requiredTools: totally_unknown_tool');
  });
});