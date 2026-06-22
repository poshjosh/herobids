import { describe, expect, it, vi } from 'vitest';
import type { Database } from './index.js';
import { buildRuntimeDescriptor, resolveRuntimeCapabilityDescriptor } from './agent-runtime-descriptor.js';
import { PROGRAMMING_SKILL, FILE_MANAGEMENT_SKILL } from '@herobids/domain';

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
    skillId: 'custom-skill',
    name: 'Custom Skill',
    description: 'Custom instructions',
    instructions: 'Do the custom thing',
    requiredTools: [],
    contextRequirements: [],
    requiredGuardrails: [],
    capabilityFamilies: [],
    suggestedTickIntervalMs: 900_000,
    ...overrides,
  };
}

describe('resolveRuntimeCapabilityDescriptor', () => {
  it('resolves the built-in programming skill with execute_code', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [createSkillRow({
              skillId: 'programming',
              name: PROGRAMMING_SKILL.name,
              description: PROGRAMMING_SKILL.description,
              instructions: PROGRAMMING_SKILL.instructions,
              requiredTools: PROGRAMMING_SKILL.requiredTools,
              contextRequirements: PROGRAMMING_SKILL.contextRequirements,
              requiredGuardrails: PROGRAMMING_SKILL.requiredGuardrails,
              capabilityFamilies: PROGRAMMING_SKILL.capabilityFamilies,
              suggestedTickIntervalMs: PROGRAMMING_SKILL.suggestedTickIntervalMs,
            })]
          : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1');

    expect(descriptor.resolvedSkills.map((skill) => skill.id)).toEqual(['base', 'programming']);
    expect(descriptor.resolvedSkills[1]?.requiredTools).toEqual(PROGRAMMING_SKILL.requiredTools);
    expect(descriptor.resolvedSkills[1]?.requiredTools).toEqual(['execute_code']);
  });

  it('resolves the built-in file-management skill with workspace tools', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [createSkillRow({
              skillId: 'file-management',
              name: FILE_MANAGEMENT_SKILL.name,
              description: FILE_MANAGEMENT_SKILL.description,
              instructions: FILE_MANAGEMENT_SKILL.instructions,
              requiredTools: FILE_MANAGEMENT_SKILL.requiredTools,
              contextRequirements: FILE_MANAGEMENT_SKILL.contextRequirements,
              requiredGuardrails: FILE_MANAGEMENT_SKILL.requiredGuardrails,
              capabilityFamilies: FILE_MANAGEMENT_SKILL.capabilityFamilies,
              suggestedTickIntervalMs: FILE_MANAGEMENT_SKILL.suggestedTickIntervalMs,
            })]
          : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1');

    expect(descriptor.resolvedSkills.map((skill) => skill.id)).toEqual(['base', 'file-management']);
    expect(descriptor.resolvedSkills[1]?.requiredTools).toEqual(FILE_MANAGEMENT_SKILL.requiredTools);
  });

  it('resolves both programming and file-management when stacked', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [
              createSkillRow({
                skillId: 'programming',
                name: PROGRAMMING_SKILL.name,
                description: PROGRAMMING_SKILL.description,
                instructions: PROGRAMMING_SKILL.instructions,
                requiredTools: PROGRAMMING_SKILL.requiredTools,
                contextRequirements: PROGRAMMING_SKILL.contextRequirements,
                requiredGuardrails: PROGRAMMING_SKILL.requiredGuardrails,
                capabilityFamilies: PROGRAMMING_SKILL.capabilityFamilies,
                suggestedTickIntervalMs: PROGRAMMING_SKILL.suggestedTickIntervalMs,
              }),
              createSkillRow({
                skillId: 'file-management',
                name: FILE_MANAGEMENT_SKILL.name,
                description: FILE_MANAGEMENT_SKILL.description,
                instructions: FILE_MANAGEMENT_SKILL.instructions,
                requiredTools: FILE_MANAGEMENT_SKILL.requiredTools,
                contextRequirements: FILE_MANAGEMENT_SKILL.contextRequirements,
                requiredGuardrails: FILE_MANAGEMENT_SKILL.requiredGuardrails,
                capabilityFamilies: FILE_MANAGEMENT_SKILL.capabilityFamilies,
                suggestedTickIntervalMs: FILE_MANAGEMENT_SKILL.suggestedTickIntervalMs,
              }),
            ]
          : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1');

    const skillIds = descriptor.resolvedSkills.map((skill) => skill.id);
    expect(skillIds).toContain('programming');
    expect(skillIds).toContain('file-management');
  });

  it('fails loudly for unknown required tools in stored skill rows', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [createSkillRow({ skillId: 'invalid-skill', requiredTools: ['totally_unknown_tool'] })]
          : []);
      }),
    } as unknown as Database;

    await expect(resolveRuntimeCapabilityDescriptor(db, 'agent-1'))
      .rejects
      .toThrow('Skill invalid-skill references unknown requiredTools: totally_unknown_tool');
  });

  it('chooses the newest ready trading binding as the default', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [createSkillRow({ skillId: 'trading', requiredTools: ['submit_decision'], capabilityFamilies: ['trading'] })]
          : [
              {
                family: 'trading',
                grantStatus: 'active',
                grantedAt: new Date('2026-06-11T06:00:00Z'),
                bindingId: 'binding-1',
                bindingStatus: 'active',
                connectionId: 'conn-1',
                connectionStatus: 'active',
                provider: 'hyperliquid',
                label: 'Older ready binding',
                bindingRef: null,
                bindingProfile: null,
                sourceVenueAccountId: 'va-1',
              },
              {
                family: 'trading',
                grantStatus: 'active',
                grantedAt: new Date('2026-06-11T07:00:00Z'),
                bindingId: 'binding-2',
                bindingStatus: 'active',
                connectionId: 'conn-2',
                connectionStatus: 'active',
                provider: 'jupiter',
                label: 'Newest ready binding',
                bindingRef: null,
                bindingProfile: null,
                sourceVenueAccountId: 'va-2',
              },
            ]);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1');

    expect(descriptor.defaultBindingByFamily.trading).toBe('binding-2');
    expect(descriptor.grantedBindingsByFamily.trading).toEqual([
      expect.objectContaining({ bindingId: 'binding-1', isDefault: false }),
      expect.objectContaining({ bindingId: 'binding-2', isDefault: true }),
    ]);
  });
});

describe('buildRuntimeDescriptor', () => {
  it('clones the runtime budget snapshot', () => {
    const budgets = {
      maxHistoryMessages: 20,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4000,
      maxVisibleToolSchemas: 37,
      maxContextBlockChars: 4000,
    };

    const descriptor = buildRuntimeDescriptor({
      agentId: 'agent-1',
      goal: 'Test agent',
      budgets,
      capabilityDescriptor: {
        resolvedSkills: [],
        grantedBindingsByFamily: {},
        readinessByFamily: {},
        defaultBindingByFamily: {},
      },
    });

    budgets.maxVisibleToolSchemas = 99;

    expect(descriptor.budgets.maxVisibleToolSchemas).toBe(37);
    expect(descriptor.budgets).not.toBe(budgets);
  });
});