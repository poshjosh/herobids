import { describe, it, expect } from 'vitest';
import {
  BOT_MANAGEMENT_SKILL,
  BUILTIN_TRADING_SOURCE_REFS,
  RISK_MONITORING_SKILL,
  TRADING_SKILL,
  TOOL_CATALOG,
  getToolCatalogEntry,
  type SkillDefinition,
} from '@herobids/domain';
import {
  resolveDescriptorTools,
  type DescriptorTrustPolicy,
} from '@herobids/domain/external-backend';
import {
  createStubDescriptorSource,
  STUB_DESCRIPTOR_KEY_ID,
  type StubToolSchemaLookup,
} from './stub-descriptor-source.js';

const BACKEND_ID = 'traderton';
const TRADING_SKILLS: readonly SkillDefinition[] = [TRADING_SKILL, BOT_MANAGEMENT_SKILL, RISK_MONITORING_SKILL];
const NOW = new Date('2026-10-15T00:00:00.000Z');

// Mirror the registry's lookup: every built-in trading tool has a TOOL_CATALOG
// entry, so this synthesises a schema with the catalog's category (the DT4 field
// the resolver cross-checks) and a minimal valid inputSchema.
const lookupToolSchema: StubToolSchemaLookup = (toolName) => {
  const entry = getToolCatalogEntry(toolName);
  if (entry === undefined) return undefined;
  return {
    name: toolName,
    description: entry.description,
    category: entry.category,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
};

function stubPolicy(stubKeyPem: string, overrides: Partial<DescriptorTrustPolicy> = {}): DescriptorTrustPolicy {
  return {
    backendId: BACKEND_ID,
    enabled: true,
    trustedDescriptorSigningKeys: [{ keyId: STUB_DESCRIPTOR_KEY_ID, publicKey: stubKeyPem, status: 'active' }],
    approvedSourceSkillRefs: [
      BUILTIN_TRADING_SOURCE_REFS['trading']!,
      BUILTIN_TRADING_SOURCE_REFS['bot-management']!,
      BUILTIN_TRADING_SOURCE_REFS['risk-monitoring']!,
    ],
    descriptorPinning: { mode: 'maxAge', seconds: 3600 },
    ...overrides,
  };
}

describe('createStubDescriptorSource', () => {
  it('binds each D11 ref to its built-in skill tools, verifiable under the ephemeral key', () => {
    const stub = createStubDescriptorSource({ backendId: BACKEND_ID, tradingSkills: TRADING_SKILLS, lookupToolSchema, now: NOW });

    expect(stub.keyId).toBe(STUB_DESCRIPTOR_KEY_ID);
    expect(stub.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(stub.descriptor.backendId).toBe(BACKEND_ID);

    const refs = stub.descriptor.sourceSkills.map((s) => s.ref).sort();
    expect(refs).toEqual(
      [
        BUILTIN_TRADING_SOURCE_REFS['trading']!,
        BUILTIN_TRADING_SOURCE_REFS['bot-management']!,
        BUILTIN_TRADING_SOURCE_REFS['risk-monitoring']!,
      ].sort(),
    );

    // The pipeline resolves each ref to exactly that skill's requiredTools.
    const policy = stubPolicy(stub.publicKeyPem);
    const wrapper = stub.source.getDescriptor(BACKEND_ID)!;
    for (const skill of TRADING_SKILLS) {
      const result = resolveDescriptorTools({
        definition: policy,
        wrapper,
        installedSkillRef: BUILTIN_TRADING_SOURCE_REFS[skill.id]!,
        now: NOW,
      });
      expect(result.outcome).toBe('tools_exposed');
      if (result.outcome !== 'tools_exposed') throw new Error('unreachable');
      expect(result.tools.map((t) => t.name)).toEqual(skill.requiredTools);
    }
  });

  it('every stub tool category equals its TOOL_CATALOG entry (DT4 cross-check passes)', () => {
    const stub = createStubDescriptorSource({ backendId: BACKEND_ID, tradingSkills: TRADING_SKILLS, lookupToolSchema, now: NOW });
    for (const sourceSkill of stub.descriptor.sourceSkills) {
      for (const tool of sourceSkill.tools) {
        expect(TOOL_CATALOG[tool.name]?.category).toBe(tool.category);
      }
    }
  });

  it('returns undefined for a different backendId', () => {
    const stub = createStubDescriptorSource({ backendId: BACKEND_ID, tradingSkills: TRADING_SKILLS, lookupToolSchema, now: NOW });
    expect(stub.source.getDescriptor('some-other-backend')).toBeUndefined();
  });

  it('throws if a bound tool is not registered (stub must mirror registered tools)', () => {
    const badLookup: StubToolSchemaLookup = () => undefined;
    expect(() => createStubDescriptorSource({ backendId: BACKEND_ID, tradingSkills: [TRADING_SKILL], lookupToolSchema: badLookup, now: NOW }))
      .toThrow(/is not a registered tool/);
  });
});
