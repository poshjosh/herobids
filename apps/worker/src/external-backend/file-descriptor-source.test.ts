import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BOT_MANAGEMENT_SKILL,
  BUILTIN_TRADING_SOURCE_REFS,
  RISK_MONITORING_SKILL,
  TRADING_SKILL,
  TOOL_CATALOG,
  type SkillDefinition,
} from '@herobids/domain';
import {
  resolveDescriptorTools,
  verifyDescriptorSignature,
  type DescriptorTrustPolicy,
} from '@herobids/domain/external-backend';
import {
  createFileDescriptorSource,
  descriptorFilePath,
  type FileDescriptorSourceLogger,
} from './file-descriptor-source.js';

const BACKEND_ID = 'traderton';
const KEY_ID = 'traderton-dev-1';
const TRADING_SKILLS: readonly SkillDefinition[] = [TRADING_SKILL, BOT_MANAGEMENT_SKILL, RISK_MONITORING_SKILL];
// Inside the committed descriptor's validity window (issued ~now, expires in a decade).
const NOW = new Date('2027-01-01T00:00:00.000Z');

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const COMMITTED_PUBLIC_KEY_PEM = readFileSync(
  resolve(REPO_ROOT, 'config/external-backends/traderton.descriptor.pub.pem'),
  'utf8',
);

function makeLogger(): { logger: FileDescriptorSourceLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn }, warn };
}

/** The trust policy the config forwards for traderton, with the committed dev key. */
function committedPolicy(overrides: Partial<DescriptorTrustPolicy> = {}): DescriptorTrustPolicy {
  return {
    backendId: BACKEND_ID,
    enabled: true,
    trustedDescriptorSigningKeys: [{ keyId: KEY_ID, publicKey: COMMITTED_PUBLIC_KEY_PEM, status: 'active' }],
    approvedSourceSkillRefs: [
      BUILTIN_TRADING_SOURCE_REFS['trading']!,
      BUILTIN_TRADING_SOURCE_REFS['bot-management']!,
      BUILTIN_TRADING_SOURCE_REFS['risk-monitoring']!,
    ],
    descriptorPinning: { mode: 'maxAge', seconds: 3600 },
    ...overrides,
  };
}

describe('createFileDescriptorSource — serves the committed dev-signed descriptor', () => {
  it('returns the committed wrapper for the matching backendId', () => {
    const { logger, warn } = makeLogger();
    const source = createFileDescriptorSource({ backendId: BACKEND_ID, logger });
    const wrapper = source.getDescriptor(BACKEND_ID);

    expect(warn).not.toHaveBeenCalled();
    expect(wrapper).toBeDefined();
    expect(wrapper!.keyId).toBe(KEY_ID);
    expect(wrapper!.descriptor.backendId).toBe(BACKEND_ID);
  });

  it('returns undefined for a different backendId', () => {
    const { logger } = makeLogger();
    const source = createFileDescriptorSource({ backendId: BACKEND_ID, logger });
    expect(source.getDescriptor('some-other-backend')).toBeUndefined();
  });

  it('binds each D11 ref to its built-in skill tools, verifiable under the committed public key', () => {
    const { logger } = makeLogger();
    const source = createFileDescriptorSource({ backendId: BACKEND_ID, logger });
    const wrapper = source.getDescriptor(BACKEND_ID)!;

    const refs = wrapper.descriptor.sourceSkills.map((s) => s.ref).sort();
    expect(refs).toEqual(
      [
        BUILTIN_TRADING_SOURCE_REFS['trading']!,
        BUILTIN_TRADING_SOURCE_REFS['bot-management']!,
        BUILTIN_TRADING_SOURCE_REFS['risk-monitoring']!,
      ].sort(),
    );

    const policy = committedPolicy();
    for (const skill of TRADING_SKILLS) {
      const result = resolveDescriptorTools({
        definition: policy,
        wrapper,
        installedSkillRef: BUILTIN_TRADING_SOURCE_REFS[skill.id]!,
        now: NOW,
      });
      expect(result.outcome).toBe('tools_exposed');
      if (result.outcome !== 'tools_exposed') throw new Error('unreachable');
      // Parity: the descriptor exposes exactly the skill's requiredTools, in order.
      expect(result.tools.map((t) => t.name)).toEqual(skill.requiredTools);
    }
  });

  it('the committed descriptor signature verifies under the committed public key', () => {
    const { logger } = makeLogger();
    const source = createFileDescriptorSource({ backendId: BACKEND_ID, logger });
    const wrapper = source.getDescriptor(BACKEND_ID)!;
    expect(verifyDescriptorSignature(wrapper.descriptor, wrapper.signature, COMMITTED_PUBLIC_KEY_PEM)).toBe(true);
  });

  it('every descriptor tool category equals its TOOL_CATALOG entry (DT4 cross-check passes)', () => {
    const { logger } = makeLogger();
    const source = createFileDescriptorSource({ backendId: BACKEND_ID, logger });
    const wrapper = source.getDescriptor(BACKEND_ID)!;
    for (const sourceSkill of wrapper.descriptor.sourceSkills) {
      for (const tool of sourceSkill.tools) {
        expect(TOOL_CATALOG[tool.name]?.category).toBe(tool.category);
      }
    }
  });

  it('degrades (returns undefined, logs once) when no committed descriptor exists for the backend', () => {
    const { logger, warn } = makeLogger();
    // A backendId with no committed descriptor file → read fails → undefined.
    const source = createFileDescriptorSource({ backendId: 'no-such-backend', logger });
    expect(source.getDescriptor('no-such-backend')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('descriptorFilePath points at the committed JSON under config/external-backends', () => {
    expect(descriptorFilePath(BACKEND_ID).replace(/\\/g, '/')).toMatch(
      /config\/external-backends\/traderton\.descriptor\.json$/,
    );
  });
});
