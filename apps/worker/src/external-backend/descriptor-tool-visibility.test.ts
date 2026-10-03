import { describe, it, expect, vi } from 'vitest';
import {
  BASE_SKILL,
  BOT_MANAGEMENT_SKILL,
  RISK_MONITORING_SKILL,
  TRADING_SKILL,
  WEB_ACCESS_SKILL,
  getToolCatalogEntry,
  type SkillDefinition,
} from '@herobids/domain';
import { ExternalBackendRegistrySchema, resolveExternalBackend } from '@herobids/domain';
import { buildDescriptorToolVisibility, type DescriptorToolVisibilityLogger } from './descriptor-tool-visibility.js';
import type { StubToolSchemaLookup } from './stub-descriptor-source.js';

const NOW = new Date('2026-10-15T00:00:00.000Z');

// The three D11 refs are the operator-approved set; config carries them. This
// fixture reproduces the forwarded ResolvedExternalBackend payload the worker
// builds (registry → resolveExternalBackend → JSON.stringify), with the real
// traderton approvedSourceSkillRefs and an EMPTY trustedDescriptorSigningKeys
// (the stub splices its ephemeral public key in at runtime).
function tradertonConfigJson(overrides: { approvedSourceSkillRefs?: string[] } = {}): string {
  const registry = ExternalBackendRegistrySchema.parse({
    traderton: {
      enabled: true,
      endpoint: { baseUrl: 'http://localhost:8080', requestTimeoutMs: 10_000 },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'TRADERTON_BOUNDARY_HMAC_SECRET' },
      trustedDescriptorSigningKeys: [],
      approvedSourceSkillRefs: overrides.approvedSourceSkillRefs ?? [
        'traderton/skills/crypto-trading',
        'traderton/skills/crypto-bot-management',
        'traderton/skills/crypto-risk-monitoring',
      ],
      descriptorPinning: { mode: 'maxAge', seconds: 3600 },
    },
  });
  const resolved = resolveExternalBackend(registry, 'traderton', { TRADERTON_BOUNDARY_HMAC_SECRET: 'dev-secret' });
  if (!resolved.ok) throw new Error(`fixture did not resolve: ${resolved.error.code}`);
  return JSON.stringify(resolved.data);
}

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

function makeLogger(): { logger: DescriptorToolVisibilityLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: DescriptorToolVisibilityLogger = { info: vi.fn(), warn };
  return { logger, warn };
}

const TRADING_SKILLS: readonly SkillDefinition[] = [TRADING_SKILL, BOT_MANAGEMENT_SKILL, RISK_MONITORING_SKILL];

/** The visible tool-name set from a set of resolved skills (= getVisibleToolNames input). */
function visibleTools(skills: readonly SkillDefinition[]): string[] {
  return [...new Set(skills.flatMap((skill) => skill.requiredTools))].sort();
}

describe('buildDescriptorToolVisibility — parity (the success bar)', () => {
  it('a D11-ref agent sees EXACTLY the trading tools it sees today, via the generic path', () => {
    const resolvedSkills = [BASE_SKILL, ...TRADING_SKILLS];
    const before = visibleTools(resolvedSkills);

    const { logger } = makeLogger();
    const result = buildDescriptorToolVisibility({
      rawConfigJson: tradertonConfigJson(),
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });

    // Every trading skill resolved via the generic (descriptor) path.
    const tradingOutcomes = result.outcomes.filter((o) => TRADING_SKILLS.some((s) => s.id === o.skillId));
    expect(tradingOutcomes).toHaveLength(3);
    expect(tradingOutcomes.every((o) => o.outcome === 'tools_exposed')).toBe(true);

    // Visible tool set is byte-identical to the pre-T3.2 trading tool set.
    expect(visibleTools(result.resolvedSkills)).toEqual(before);

    // Per-skill parity: requiredTools unchanged.
    for (const skill of TRADING_SKILLS) {
      const resolved = result.resolvedSkills.find((s) => s.id === skill.id)!;
      expect(resolved.requiredTools).toEqual(skill.requiredTools);
      // capabilityFamilies preserved so the §6-fence consumers still fire.
      expect(resolved.capabilityFamilies).toEqual(skill.capabilityFamilies);
    }
  });

  it('preserves non-matching platform skills unchanged (no_match)', () => {
    const resolvedSkills = [BASE_SKILL, WEB_ACCESS_SKILL];
    const { logger } = makeLogger();
    const result = buildDescriptorToolVisibility({
      rawConfigJson: tradertonConfigJson(),
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });
    expect(result.outcomes).toHaveLength(0);
    expect(result.resolvedSkills).toEqual(resolvedSkills);
  });

  it('resolves to no_match (unchanged) when no backend is forwarded', () => {
    const resolvedSkills = [BASE_SKILL, ...TRADING_SKILLS];
    const { logger } = makeLogger();
    const result = buildDescriptorToolVisibility({
      rawConfigJson: undefined,
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });
    expect(result.outcomes).toHaveLength(0);
    expect(result.resolvedSkills).toEqual(resolvedSkills);
  });
});

describe('buildDescriptorToolVisibility — degrade matrix (instruction-only, no crash; T0.4 reason codes)', () => {
  it('a definition that arrives disabled → every matched trading skill degrades (definition.disabled)', () => {
    // resolveExternalBackend refuses to forward a disabled backend, so this
    // builds the payload directly to exercise the trust pipeline's revocation
    // branch (Step 10 §4) at the composition layer.
    const enabledJson = tradertonConfigJson();
    const payload = JSON.parse(enabledJson);
    payload.definition.enabled = false;
    const resolvedSkills = [BASE_SKILL, ...TRADING_SKILLS];
    const { logger } = makeLogger();
    const result = buildDescriptorToolVisibility({
      rawConfigJson: JSON.stringify(payload),
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });
    const outcomes = result.outcomes.filter((o) => TRADING_SKILLS.some((s) => s.id === o.skillId));
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.outcome === 'instruction_only' && o.reason === 'definition.disabled')).toBe(true);
    // instruction-only: no tools for the degraded skills.
    for (const skill of TRADING_SKILLS) {
      expect(result.resolvedSkills.find((s) => s.id === skill.id)!.requiredTools).toEqual([]);
    }
  });

  it('a ref removed from approvedSourceSkillRefs → that skill degrades (ref_not_approved); the rest resolve', () => {
    const resolvedSkills = [BASE_SKILL, ...TRADING_SKILLS];
    const { logger } = makeLogger();
    const result = buildDescriptorToolVisibility({
      // trading ref removed from the approved set → no match for the trading skill;
      // bot-management + risk-monitoring still approved and resolve.
      rawConfigJson: tradertonConfigJson({
        approvedSourceSkillRefs: [
          'traderton/skills/crypto-bot-management',
          'traderton/skills/crypto-risk-monitoring',
        ],
      }),
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });
    // The trading skill no longer matches any approved ref → no_match → unchanged.
    const tradingResolved = result.resolvedSkills.find((s) => s.id === 'trading')!;
    expect(tradingResolved.requiredTools).toEqual(TRADING_SKILL.requiredTools);
    expect(result.outcomes.find((o) => o.skillId === 'trading')).toBeUndefined();

    // The other two matched and resolved.
    const resolvedIds = result.outcomes.filter((o) => o.outcome === 'tools_exposed').map((o) => o.skillId).sort();
    expect(resolvedIds).toEqual(['bot-management', 'risk-monitoring']);
  });

  it('never throws on a malformed config payload — degrades to no_match (unchanged)', () => {
    const resolvedSkills = [BASE_SKILL, ...TRADING_SKILLS];
    const { logger, warn } = makeLogger();
    const result = buildDescriptorToolVisibility({
      rawConfigJson: '{ not valid json',
      resolvedSkills,
      lookupToolSchema,
      now: NOW,
      logger,
    });
    expect(result.outcomes).toHaveLength(0);
    expect(result.resolvedSkills).toEqual(resolvedSkills);
    expect(warn).toHaveBeenCalled();
  });
});
