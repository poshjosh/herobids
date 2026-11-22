// Regression guard for the tool gap between Traderton's skill map and the local
// registry (spec: preset-tools-dropped-no-local-registry). Herobids shows an agent
// only the tools that are both tagged by Traderton AND present in the local tool
// registry, so a tagged tool with no local entry is dropped silently.
//
// The fixture is a names-only copy of Traderton's SKILL_TOOL_MAP. It carries no
// schemas, preset definitions or logic (AGENTS.md: do not reintroduce mirrored
// trading files). Keep it that way.
//
// How to refresh the fixture: re-copy the tool names from SKILL_TOOL_MAP in
// Traderton's packages/boundary/src/mcp/skill-tool-map.ts, update source.commit in
// the fixture, and do it in the same change that adds the matching local proxy
// (also add the name to KNOWN_AGENT_TOOL_NAMES, TOOL_CATALOG, the tools barrel and
// the capability manifest table). This test only fails for tools the fixture lists.
// It cannot see a tool Traderton adds. The live detector for that is the per-skill
// error log from buildBackendToolVisibility (droppedToolNames) at agent start.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import type { DiscoveredBackendTool } from '@herobids/domain/external-backend';
import { createToolRegistry } from '../tools/index.js';
import { buildBackendToolVisibility, type BackendToolVisibilityResult } from './backend-tool-visibility.js';

const CRYPTO_TRADING_REF = 'traderton/skills/crypto-trading';
const CRYPTO_BOT_MANAGEMENT_REF = 'traderton/skills/crypto-bot-management';
const CRYPTO_RISK_MONITORING_REF = 'traderton/skills/crypto-risk-monitoring';

/** The three tools Traderton tags to crypto-trading that Herobids had no local tool for. */
const PRESET_TOOLS = ['list_strategy_presets', 'assess_strategy_preset', 'change_strategy_preset'] as const;

/** Tools Traderton does not tag to any skill (consumer-only reads). Must stay hidden from agents. */
const UNTAGGED_CONSUMER_TOOLS = ['list_agent_strategy_changes', 'get_assessment_artifact', 'get_strategy_presets'] as const;

// ── Fixture loading ──────────────────────────────────────────────────────────

interface SkillToolFixture {
  skills: Record<string, string[]>;
  notExposed: Record<string, Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function loadFixture(): SkillToolFixture {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('./__fixtures__/traderton-skill-tools.json', import.meta.url), 'utf8'),
  );
  if (!isRecord(parsed) || !isRecord(parsed['skills']) || !isRecord(parsed['notExposed'])) {
    throw new Error('malformed traderton-skill-tools fixture');
  }
  const skills: Record<string, string[]> = {};
  for (const [ref, names] of Object.entries(parsed['skills'])) {
    if (!isStringArray(names)) throw new Error(`malformed fixture skill: ${ref}`);
    skills[ref] = names;
  }
  const notExposed: Record<string, Record<string, string>> = {};
  for (const [ref, entries] of Object.entries(parsed['notExposed'])) {
    if (!isRecord(entries)) throw new Error(`malformed fixture notExposed: ${ref}`);
    const reasons: Record<string, string> = {};
    for (const [name, reason] of Object.entries(entries)) {
      if (typeof reason !== 'string') throw new Error(`malformed fixture notExposed reason: ${ref}/${name}`);
      reasons[name] = reason;
    }
    notExposed[ref] = reasons;
  }
  return { skills, notExposed };
}

const fixture = loadFixture();

function fixtureTools(ref: string): string[] {
  const names = fixture.skills[ref];
  if (!names) throw new Error(`fixture has no skill ${ref}`);
  return names;
}

/** Tools Herobids is expected to expose for a skill: tagged tools minus the explicit allow-list. */
function expectedTools(ref: string): string[] {
  const notExposed = fixture.notExposed[ref] ?? {};
  return fixtureTools(ref).filter((name) => !(name in notExposed));
}

/** Names the local registry can actually invoke, read live from the real registry. */
function realRegistryNames(): Set<string> {
  return new Set(createToolRegistry().list().map((tool) => tool.name));
}

/**
 * What Traderton's MCP tools/list returns for the fixture: every distinct tool once,
 * tagged with every skill ref it belongs to (a tool in several skills carries all refs).
 */
function discoveryFromFixture(): DiscoveredBackendTool[] {
  const refsByTool = new Map<string, string[]>();
  for (const [ref, names] of Object.entries(fixture.skills)) {
    for (const name of names) {
      const refs = refsByTool.get(name);
      if (!refs) refsByTool.set(name, [ref]);
      else if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return [...refsByTool.entries()].map(([name, skillRefs]) => ({
    name,
    description: `d:${name}`,
    inputSchema: { type: 'object' },
    skillRefs,
  }));
}

// ── Builders (same shape as backend-tool-visibility.test.ts) ─────────────────

function skill(partial: Partial<SkillDefinition> & { id: string }): SkillDefinition {
  return {
    name: partial.id,
    description: 'desc',
    instructions: '',
    requiredTools: [],
    capabilityFamilies: [],
    bindingRequirements: {},
    contextRequirements: [],
    requiredContextBlocks: ['corePlatformContext'],
    promptRendererHints: ['core-system'],
    requiredGuardrails: [],
    suggestedTickIntervalMs: 900_000,
    visibility: 'private',
    ...partial,
  };
}

function resolvedConfigJson(opts: { approvedRefs: string[]; family?: string }): string {
  return JSON.stringify({
    definition: {
      backendId: 'traderton',
      endpoint: {
        baseUrl: 'http://localhost:8080',
        mcpPath: '/internal/v1/mcp',
        discoveryRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'TRADERTON_HMAC_SECRET' },
      approvedSourceSkillRefs: opts.approvedRefs,
      ...(opts.family ? { requiresConnectionFamily: opts.family } : {}),
    },
    hmacSecret: 'secret',
  });
}

/** A fresh logger per run. `error` is present so the same helper works before and after the logger change. */
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ALL_REFS = [CRYPTO_TRADING_REF, CRYPTO_BOT_MANAGEMENT_REF, CRYPTO_RISK_MONITORING_REF];

async function runCryptoTrading(
  registryToolNames: ReadonlySet<string>,
  logger = makeLogger(),
): Promise<{ result: BackendToolVisibilityResult; logger: ReturnType<typeof makeLogger> }> {
  const result = await buildBackendToolVisibility({
    rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
    resolvedSkills: [skill({ id: 'crypto-trading', sourceRef: CRYPTO_TRADING_REF })],
    registryToolNames,
    logger,
    discoverTools: async () => discoveryFromFixture(),
  });
  return { result, logger };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Number of tools Traderton tags to crypto-trading, from the fixture. */
function taggedCount(): number {
  return fixtureTools(CRYPTO_TRADING_REF).length;
}

// ── Task 1: bug condition exploration (must FAIL on unfixed code) ────────────

describe('Traderton crypto-trading tools vs the local tool registry', () => {
  it('has a local registry entry for every tool Traderton tags to crypto-trading', () => {
    const registry = realRegistryNames();
    const missing = expectedTools(CRYPTO_TRADING_REF).filter((name) => !registry.has(name));
    expect(
      missing,
      `skill ${CRYPTO_TRADING_REF}: tools tagged by Traderton with no local registry entry: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  describe('visibility over the fixture and the real registry', () => {
    let run: Awaited<ReturnType<typeof runCryptoTrading>>;

    beforeAll(async () => {
      run = await runCryptoTrading(realRegistryNames());
    });

    it('exposes all 22 tagged tools as the skill requiredTools', () => {
      expect(sorted(run.result.resolvedSkills[0]!.requiredTools)).toEqual(sorted(expectedTools(CRYPTO_TRADING_REF)));
    });

    it('drops no tagged tool', () => {
      expect(run.result.outcomes[0]?.droppedTools).toEqual([]);
    });

    it('reports 22 of 22 tagged tools visible in the summary log', () => {
      expect(run.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ toolCount: 22, taggedToolCount: taggedCount(), droppedTools: [] }),
        expect.any(String),
      );
    });

    it('logs no error for the skill', () => {
      expect(run.logger.error).not.toHaveBeenCalled();
    });
  });

  it('keeps every notExposed entry honest: tagged, absent from the registry, with a reason', () => {
    const registry = realRegistryNames();
    for (const [ref, entries] of Object.entries(fixture.notExposed)) {
      for (const [name, reason] of Object.entries(entries)) {
        expect(fixtureTools(ref), `notExposed ${ref}/${name} is not a tagged tool`).toContain(name);
        expect(registry.has(name), `notExposed ${ref}/${name} is in the registry; remove the stale entry`).toBe(false);
        expect(reason.trim().length, `notExposed ${ref}/${name} needs a reason`).toBeGreaterThan(0);
      }
    }
  });

  it('has a local registry entry for every tool of the other two Traderton skills', () => {
    const registry = realRegistryNames();
    for (const ref of [CRYPTO_BOT_MANAGEMENT_REF, CRYPTO_RISK_MONITORING_REF]) {
      const missing = expectedTools(ref).filter((name) => !registry.has(name));
      expect(missing, `skill ${ref}: tools tagged by Traderton with no local registry entry: ${missing.join(', ')}`).toEqual([]);
    }
  });

  describe('negative control: the guard can fail', () => {
    it('reports exactly the removed tool as dropped and logs one error when change_strategy_preset has no local tool', async () => {
      const registry = realRegistryNames();
      registry.delete('change_strategy_preset');

      const { result, logger } = await runCryptoTrading(registry);

      expect(result.outcomes[0]?.droppedTools).toEqual([{ name: 'change_strategy_preset', reason: 'not_in_local_registry' }]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          skillId: 'crypto-trading',
          sourceRef: CRYPTO_TRADING_REF,
          droppedToolNames: ['change_strategy_preset'],
        }),
        expect.any(String),
      );
    });
  });

  describe('drop sets over the fixture', () => {
    const tools = expectedTools(CRYPTO_TRADING_REF);
    const removalSets: string[][] = [
      [],
      ...tools.map((name) => [name]),
      [PRESET_TOOLS[0], PRESET_TOOLS[1]],
      [PRESET_TOOLS[0], PRESET_TOOLS[2]],
      [PRESET_TOOLS[1], PRESET_TOOLS[2]],
      [...PRESET_TOOLS],
    ];

    it.each(removalSets.map((removed) => [removed.join(',') || '(none)', removed] as const))(
      'with %s removed from the registry: dropped equals removed, visible plus dropped equals tagged, error logged iff non-empty',
      async (_label, removed) => {
        const registry = new Set(tools);
        for (const name of removed) registry.delete(name);

        const { result, logger } = await runCryptoTrading(registry);
        const outcome = result.outcomes[0]!;
        const dropped = outcome.droppedTools.map((entry) => entry.name);

        expect(sorted(dropped)).toEqual(sorted(removed));
        expect(sorted([...outcome.toolNames, ...dropped])).toEqual(sorted(tools));
        expect(logger.error).toHaveBeenCalledTimes(removed.length > 0 ? 1 : 0);
        expect(logger.warn).not.toHaveBeenCalledWith(
          expect.objectContaining({ tool: expect.any(String) }),
          expect.any(String),
        );
      },
    );
  });

  // The runtime gate in agent.ts executeTool is a closure inside the agent module (not importable in a
  // unit test). After the allowedTools() check it does `toolRegistry.get(call.tool)` and answers
  // `unknown tool: <name>` when that is undefined, so the registry is the only thing left to assert.
  it.each(PRESET_TOOLS)('lets the runtime execute %s (the registry has the tool)', (name) => {
    expect(createToolRegistry().get(name)).toBeDefined();
  });
});

// ── Task 2.2: preservation (must PASS on unfixed AND fixed code) ─────────────
// Parametrised over registry name sets, not the real registry, so the assertions hold
// whether or not the three preset tools are registered.

describe('visibility preservation outside the bug condition', () => {
  const UNCHANGED_TOOLS = expectedTools(CRYPTO_TRADING_REF).filter(
    (name) => !(PRESET_TOOLS as readonly string[]).includes(name),
  );
  const registryWithoutPresetTools = new Set([...UNCHANGED_TOOLS, ...UNTAGGED_CONSUMER_TOOLS]);
  const registryWithPresetTools = new Set([...registryWithoutPresetTools, ...PRESET_TOOLS]);

  const registries: Array<[string, ReadonlySet<string>]> = [
    ['without the preset tools', registryWithoutPresetTools],
    ['with the preset tools', registryWithPresetTools],
  ];

  /** Discovery that also advertises consumer-only tools with no skill tag, like Traderton's tools/list does. */
  async function discoverWithUntagged(): Promise<DiscoveredBackendTool[]> {
    const noSkillRefs: string[] = [];
    return [
      ...discoveryFromFixture(),
      ...UNTAGGED_CONSUMER_TOOLS.map((name) => ({
        name,
        description: `d:${name}`,
        inputSchema: { type: 'object' },
        skillRefs: noSkillRefs,
      })),
    ];
  }

  it('sanity: the fixture has the 22 / 9 / 11 shape and 19 non-preset crypto-trading tools', () => {
    expect(fixtureTools(CRYPTO_TRADING_REF)).toHaveLength(22);
    expect(fixtureTools(CRYPTO_BOT_MANAGEMENT_REF)).toHaveLength(9);
    expect(fixtureTools(CRYPTO_RISK_MONITORING_REF)).toHaveLength(11);
    expect(UNCHANGED_TOOLS).toHaveLength(19);
  });

  describe.each(registries)('registry %s', (_label, registryNames) => {
    it('keeps the 19 other crypto-trading tools visible and exposes the preset tools only when registered', async () => {
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
        resolvedSkills: [skill({ id: 'crypto-trading', sourceRef: CRYPTO_TRADING_REF })],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools: discoverWithUntagged,
      });
      const visible = result.resolvedSkills[0]!.requiredTools;
      const presetsRegistered = PRESET_TOOLS.every((name) => registryNames.has(name));

      expect(sorted(visible.filter((name) => !(PRESET_TOOLS as readonly string[]).includes(name)))).toEqual(
        sorted(UNCHANGED_TOOLS),
      );
      expect(visible.filter((name) => (PRESET_TOOLS as readonly string[]).includes(name))).toHaveLength(
        presetsRegistered ? PRESET_TOOLS.length : 0,
      );
      expect(result.outcomes[0]?.taggedToolCount).toBe(22);
      expect(result.resolvedSkills[0]?.capabilityFamilies).toEqual(['trading']);
    });

    it.each(UNTAGGED_CONSUMER_TOOLS)('keeps %s hidden even when the local registry has it', async (name) => {
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
        resolvedSkills: [skill({ id: 'crypto-trading', sourceRef: CRYPTO_TRADING_REF })],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools: discoverWithUntagged,
      });
      expect(result.resolvedSkills[0]?.requiredTools).not.toContain(name);
      expect(result.outcomes[0]?.droppedTools.map((dropped) => dropped.name)).not.toContain(name);
    });

    it('returns an unapproved external skill unchanged with no backend tools and no discovery', async () => {
      const discoverTools = vi.fn(discoverWithUntagged);
      const original = skill({ id: 'ext', sourceRef: 'someone/else/skill', requiredTools: [] });
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
        resolvedSkills: [original],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools,
      });
      expect(result.resolvedSkills[0]).toEqual(original);
      expect(result.outcomes[0]?.outcome).toBe('not_approved');
      expect(discoverTools).not.toHaveBeenCalled();
    });

    it('returns a system skill unchanged with no backend tools added', async () => {
      const original = skill({ id: 'programming', requiredTools: ['execute_code'] });
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
        resolvedSkills: [original],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools: discoverWithUntagged,
      });
      expect(result.resolvedSkills[0]).toEqual(original);
      expect(result.outcomes).toEqual([]);
    });

    it.each([
      ['reports it unreachable', async () => null],
      [
        'throws during discovery',
        async (): Promise<DiscoveredBackendTool[] | null> => {
          throw new Error('mcp down');
        },
      ],
    ])('hides tools, applies the family and never throws when the backend %s', async (_case, discoverTools) => {
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS, family: 'trading' }),
        resolvedSkills: [skill({ id: 'crypto-trading', sourceRef: CRYPTO_TRADING_REF })],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools,
      });
      expect(result.resolvedSkills[0]?.requiredTools).toEqual([]);
      expect(result.resolvedSkills[0]?.capabilityFamilies).toEqual(['trading']);
      expect(result.outcomes[0]?.outcome).toBe('backend_unreachable');
      expect(result.outcomes[0]?.droppedTools).toEqual([]);
    });

    it('gives an approved skill no family when the backend requires none', async () => {
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ approvedRefs: ALL_REFS }),
        resolvedSkills: [skill({ id: 'crypto-trading', sourceRef: CRYPTO_TRADING_REF })],
        registryToolNames: registryNames,
        logger: makeLogger(),
        discoverTools: discoverWithUntagged,
      });
      expect(result.resolvedSkills[0]?.capabilityFamilies).toEqual([]);
      expect(result.resolvedSkills[0]?.bindingRequirements).toEqual({});
    });
  });

  it('keeps the other 19 crypto-trading tools visible with the real registry', async () => {
    const { result } = await runCryptoTrading(realRegistryNames());
    const visible = result.resolvedSkills[0]!.requiredTools.filter(
      (name) => !(PRESET_TOOLS as readonly string[]).includes(name),
    );
    expect(sorted(visible)).toEqual(sorted(UNCHANGED_TOOLS));
  });
});
