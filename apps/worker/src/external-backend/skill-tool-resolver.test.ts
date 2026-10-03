import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  canonicalizeJcs,
  sha256HexOfJcs,
  type Descriptor,
  type DescriptorWrapper,
  type DescriptorTrustPolicy,
} from '@herobids/domain/external-backend';
import type { ExternalBackendDescriptorSource, SkillDefinition } from '@herobids/domain';
import { resolveSkillTools } from './skill-tool-resolver.js';

// The resolver is generic: these tests use a NON-trading `example-echo` backend
// (the T0.4 fixture shapes — echo_text / reverse_text), proving the matcher names
// no backend and keys only on `sourceRef` ∈ `approvedSourceSkillRefs`. An ephemeral
// ed25519 key is minted per test run so the trust policy's public key matches the
// signature we produce — no committed key material.
const ECHO_REF = 'example/skills/echo';
const REVERSE_REF = 'example/skills/reverse';
const BACKEND_ID = 'example-echo';
const KEY_ID = 'example-echo-dev-1';
const NOW = new Date('2026-10-15T00:00:00.000Z');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signDescriptor(descriptor: Descriptor, key: KeyObject = privateKey): string {
  return sign(null, Buffer.from(canonicalizeJcs(descriptor), 'utf8'), key).toString('base64');
}

function echoDescriptor(): Descriptor {
  return {
    descriptorVersion: '2026-10-01.1',
    backendId: BACKEND_ID,
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    sourceSkills: [
      {
        ref: ECHO_REF,
        instructions: 'Call echo_text to repeat text back verbatim.',
        tools: [
          {
            name: 'echo_text',
            description: 'Returns the given text unchanged.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            // `read-config` matches the TOOL_CATALOG entry for get_schema; echo_text is
            // not a known tool, so the category cross-check does not apply to it.
            category: 'read-config',
          },
        ],
      },
      {
        ref: REVERSE_REF,
        instructions: 'Call reverse_text to reverse text.',
        tools: [
          {
            name: 'reverse_text',
            description: 'Returns the given text reversed.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            category: 'read-config',
          },
        ],
      },
    ],
  };
}

function wrap(descriptor: Descriptor, overrides: Partial<DescriptorWrapper> = {}): DescriptorWrapper {
  return { descriptor, signature: signDescriptor(descriptor), keyId: KEY_ID, ...overrides };
}

function policy(overrides: Partial<DescriptorTrustPolicy> = {}): DescriptorTrustPolicy {
  return {
    backendId: BACKEND_ID,
    enabled: true,
    trustedDescriptorSigningKeys: [{ keyId: KEY_ID, publicKey: PUBLIC_KEY_PEM, status: 'active' }],
    approvedSourceSkillRefs: [ECHO_REF, REVERSE_REF],
    descriptorPinning: { mode: 'maxAge', seconds: 86_400 },
    ...overrides,
  };
}

function sourceOf(wrapper: DescriptorWrapper | undefined): ExternalBackendDescriptorSource {
  return { getDescriptor: () => wrapper };
}

function skill(sourceRef: string | undefined): Pick<SkillDefinition, 'id' | 'sourceRef'> {
  return { id: 'test-skill', sourceRef };
}

describe('resolveSkillTools — matcher genericity', () => {
  it('matches a skill whose sourceRef is in a registry entry approvedSourceSkillRefs', async () => {
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result.outcome).toBe('tools_exposed');
    if (result.outcome !== 'tools_exposed') throw new Error('unreachable');
    expect(result.backendId).toBe(BACKEND_ID);
    expect(result.tools.map((tool) => tool.name)).toEqual(['echo_text']);
  });

  it('scopes the exposed tools to the matched installed ref only', async () => {
    const result = await resolveSkillTools({
      skill: skill(REVERSE_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result.outcome).toBe('tools_exposed');
    if (result.outcome !== 'tools_exposed') throw new Error('unreachable');
    expect(result.tools.map((tool) => tool.name)).toEqual(['reverse_text']);
  });

  it('does not match a skill with no sourceRef', async () => {
    const result = await resolveSkillTools({
      skill: skill(undefined),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('does not match a sourceRef approved by no registry entry', async () => {
    const result = await resolveSkillTools({
      skill: skill('other/repo/skill'),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('matches by iterating the registry — the correct entry wins among several', async () => {
    const unrelated = policy({ backendId: 'other-backend', approvedSourceSkillRefs: ['other/repo/skill'] });
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [unrelated, policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result.outcome).toBe('tools_exposed');
    if (result.outcome !== 'tools_exposed') throw new Error('unreachable');
    expect(result.backendId).toBe(BACKEND_ID);
  });
});

describe('resolveSkillTools — trust failures degrade to instruction-only (T0.4 reason codes)', () => {
  it('an undefined descriptor for a matched backend degrades (definition.disabled)', async () => {
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(undefined),
      now: NOW,
    });
    expect(result).toEqual({ outcome: 'instruction_only', backendId: BACKEND_ID, reason: 'definition.disabled' });
  });

  it('a disabled definition → definition.disabled', async () => {
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy({ enabled: false })],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'definition.disabled' });
  });

  it('an unknown keyId → descriptor.unknown_key', async () => {
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(echoDescriptor(), { keyId: 'nope' })),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.unknown_key' });
  });

  it('a bad signature → descriptor.signature_invalid', async () => {
    const other = generateKeyPairSync('ed25519');
    const descriptor = echoDescriptor();
    const wrapper: DescriptorWrapper = { descriptor, signature: signDescriptor(descriptor, other.privateKey), keyId: KEY_ID };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrapper),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.signature_invalid' });
  });

  it('a backend-id mismatch → descriptor.backend_mismatch', async () => {
    const descriptor = { ...echoDescriptor(), backendId: 'wrong-backend' };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.backend_mismatch' });
  });

  it('an expired descriptor → descriptor.expired', async () => {
    const descriptor = { ...echoDescriptor(), expiresAt: '2026-10-10T00:00:00.000Z' };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.expired' });
  });

  it('a pin mismatch → descriptor.pin_mismatch', async () => {
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy({ descriptorPinning: { mode: 'pinned', sha256: 'f'.repeat(64) } })],
      descriptorSource: sourceOf(wrap(echoDescriptor())),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.pin_mismatch' });
  });

  it('a pinned digest that matches → tools_exposed', async () => {
    const descriptor = echoDescriptor();
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy({ descriptorPinning: { mode: 'pinned', sha256: sha256HexOfJcs(descriptor) } })],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result.outcome).toBe('tools_exposed');
  });

  it('an approved ref absent from the descriptor → descriptor.ref_not_approved', async () => {
    const descriptor: Descriptor = { ...echoDescriptor(), sourceSkills: [] };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.ref_not_approved' });
  });
});

describe('resolveSkillTools — category cross-check (Decision 3 / DT4)', () => {
  it('a descriptor tool whose category disagrees with TOOL_CATALOG → descriptor.category_mismatch', async () => {
    // get_price is a known tool with catalog category read-market-data; the descriptor
    // declaring it under read-config is a consistency defect, not a silent mutation.
    const descriptor: Descriptor = {
      ...echoDescriptor(),
      sourceSkills: [
        {
          ref: ECHO_REF,
          instructions: 'x',
          tools: [
            {
              name: 'get_price',
              description: 'price',
              inputSchema: { type: 'object' },
              category: 'read-config',
            },
          ],
        },
      ],
    };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result).toMatchObject({ outcome: 'instruction_only', reason: 'descriptor.category_mismatch' });
  });

  it('a descriptor tool whose category agrees with TOOL_CATALOG → tools_exposed', async () => {
    const descriptor: Descriptor = {
      ...echoDescriptor(),
      sourceSkills: [
        {
          ref: ECHO_REF,
          instructions: 'x',
          tools: [
            {
              name: 'get_price',
              description: 'price',
              inputSchema: { type: 'object' },
              category: 'read-market-data',
            },
          ],
        },
      ],
    };
    const result = await resolveSkillTools({
      skill: skill(ECHO_REF),
      registry: [policy()],
      descriptorSource: sourceOf(wrap(descriptor)),
      now: NOW,
    });
    expect(result.outcome).toBe('tools_exposed');
  });
});
