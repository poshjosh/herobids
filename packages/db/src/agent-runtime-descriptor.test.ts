import { describe, expect, it, vi } from 'vitest';
import type { Database } from './index.js';
import { buildRuntimeDescriptor, resolveRuntimeCapabilityDescriptor } from './agent-runtime-descriptor.js';
import {
  EMAIL_SKILL,
  FILE_MANAGEMENT_SKILL,
  PROGRAMMING_SKILL,
  TASK_MANAGEMENT_SKILL,
  WEB_ACCESS_SKILL,
} from '@herobids/domain';

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
    expect(descriptor.resolvedSkills[1]?.requiredTools).toEqual(['execute_code', 'execute_shell']);
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

  it('keeps trading-account tools out of a personal-assistant descriptor', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1
          ? [
              createSkillRow({ skillId: TASK_MANAGEMENT_SKILL.id }),
              createSkillRow({ skillId: WEB_ACCESS_SKILL.id }),
              createSkillRow({ skillId: EMAIL_SKILL.id }),
            ]
          : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'personal-assistant-1');
    const resolvedTools = descriptor.resolvedSkills.flatMap((skill) => skill.requiredTools);
    const instructions = descriptor.resolvedSkills.map((skill) => skill.instructions).join('\n');

    expect(descriptor.resolvedSkills.map((skill) => skill.id)).toEqual([
      'base',
      'task-management',
      'web-access',
      'email',
    ]);
    expect(resolvedTools).not.toContain('get_risk_limits');
    expect(resolvedTools).not.toContain('get_account_summary');
    expect(instructions).not.toContain('get_risk_limits');
    expect(instructions).not.toContain('get_account_summary');
  });

  // Phase 4 (D21/EC-1): the built-in `trading` system skill was removed, so the
  // resolver no longer special-cases it. A trading-capable skill now arrives as
  // a stored row whose `capabilityFamilies` includes 'trading' (covered below).

  it('resolves both trading-account tools for an assigned trading-scoped custom skill', async () => {
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [createSkillRow({
          skillId: 'custom-trading-reader',
          requiredTools: ['get_risk_limits', 'get_account_summary'],
          capabilityFamilies: ['trading'],
          instructions: 'Read the trading account before making recommendations.',
        })] : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-with-custom-skill');
    const customSkill = descriptor.resolvedSkills.find((skill) => skill.id === 'custom-trading-reader')!;

    expect(customSkill.requiredTools).toEqual(['get_risk_limits', 'get_account_summary']);
    expect(customSkill.capabilityFamilies).toEqual(['trading']);
  });

  it('does not infer a trading family (nor throw) for a custom skill with unscoped account tools', async () => {
    // Step 12 T3.2: the trading-account guard and the tool-name inference were
    // removed. The DB resolver keeps the row's STORED capabilityFamilies verbatim
    // (empty here) and never infers 'trading' from tool names. The visible tool
    // set is governed downstream by the generic descriptor trust path, not here.
    let selectCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCount++;
        return makeChain(selectCount === 1 ? [createSkillRow({
          skillId: 'legacy-custom-reader',
          requiredTools: ['get_risk_limits', 'get_account_summary'],
        })] : []);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-with-legacy-custom-skill');
    const customSkill = descriptor.resolvedSkills.find((skill) => skill.id === 'legacy-custom-reader')!;

    expect(customSkill.requiredTools).toEqual(['get_risk_limits', 'get_account_summary']);
    expect(customSkill.capabilityFamilies).toEqual([]);
    expect(customSkill.sourceRef).toBeUndefined();
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
          ? [createSkillRow({ skillId: 'traderton/skills/crypto-trading', requiredTools: ['submit_decision'], capabilityFamilies: ['trading'] })]
          : [
              {
                grantStatus: 'active',
                grantedAt: new Date('2026-06-11T06:00:00Z'),
                connectionId: 'binding-1',
                connectionStatus: 'active',
                provider: 'hyperliquid',
                label: 'Older ready binding',
                providerRef: null,
                profile: null,
                resolvedVenueAccountId: 'va-1',
                capabilities: ['trading'],
              },
              {
                grantStatus: 'active',
                grantedAt: new Date('2026-06-11T07:00:00Z'),
                connectionId: 'binding-2',
                connectionStatus: 'active',
                provider: 'jupiter',
                label: 'Newest ready binding',
                providerRef: null,
                profile: null,
                resolvedVenueAccountId: 'va-2',
                capabilities: ['trading'],
              },
            ]);
      }),
    } as unknown as Database;

    const descriptor = await resolveRuntimeCapabilityDescriptor(db, 'agent-1');

    expect(descriptor.defaultConnectionByFamily.trading).toBe('binding-2');
    expect(descriptor.grantedConnectionsByFamily.trading).toEqual([
      expect.objectContaining({ connectionId: 'binding-1', isDefault: false }),
      expect.objectContaining({ connectionId: 'binding-2', isDefault: true }),
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
        grantedConnectionsByFamily: {},
        readinessByFamily: {},
        defaultConnectionByFamily: {},
      },
    });

    budgets.maxVisibleToolSchemas = 99;

    expect(descriptor.budgets.maxVisibleToolSchemas).toBe(37);
    expect(descriptor.budgets).not.toBe(budgets);
  });

  it('carries maxDrawdownPct through to guardrails', () => {
    const descriptor = buildRuntimeDescriptor({
      agentId: 'agent-1',
      goal: 'Test agent',
      maxDrawdownPct: 15,
      budgets: {
        maxHistoryMessages: 20,
        maxRecentToolMessages: 6,
        maxToolResultChars: 4000,
        maxVisibleToolSchemas: 37,
        maxContextBlockChars: 4000,
      },
      capabilityDescriptor: {
        resolvedSkills: [],
        grantedConnectionsByFamily: {},
        readinessByFamily: {},
        defaultConnectionByFamily: {},
      },
    });

    expect(descriptor.guardrails.maxDrawdownPct).toBe(15);
  });

  it('defaults maxDrawdownPct to null when not provided', () => {
    const descriptor = buildRuntimeDescriptor({
      agentId: 'agent-1',
      goal: 'Test agent',
      budgets: {
        maxHistoryMessages: 20,
        maxRecentToolMessages: 6,
        maxToolResultChars: 4000,
        maxVisibleToolSchemas: 37,
        maxContextBlockChars: 4000,
      },
      capabilityDescriptor: {
        resolvedSkills: [],
        grantedConnectionsByFamily: {},
        readinessByFamily: {},
        defaultConnectionByFamily: {},
      },
    });

    expect(descriptor.guardrails.maxDrawdownPct).toBeNull();
  });
});