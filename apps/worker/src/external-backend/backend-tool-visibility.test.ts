// Phase 4 T8 — backend-approved tool visibility over MCP discovery.
import { describe, it, expect, vi } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import type { DiscoveredBackendTool } from '@herobids/domain/external-backend';
import { buildBackendToolVisibility } from './backend-tool-visibility.js';

const APPROVED_REF = 'example/skills/echo';

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

function resolvedConfigJson(opts: { family?: string } = {}): string {
  return JSON.stringify({
    definition: {
      backendId: 'example-echo',
      endpoint: { baseUrl: 'http://localhost:8080', mcpPath: '/internal/v1/mcp' },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'EXAMPLE_HMAC_SECRET' },
      approvedSourceSkillRefs: [APPROVED_REF],
      ...(opts.family ? { requiresConnectionFamily: opts.family } : {}),
    },
    hmacSecret: 'secret',
  });
}

const logger = { info: vi.fn(), warn: vi.fn() };

function tool(name: string, refs: string[]): DiscoveredBackendTool {
  return { name, description: `d:${name}`, inputSchema: { type: 'object' }, skillRefs: refs };
}

describe('buildBackendToolVisibility', () => {
  it('exposes the backend tools tagged with the approved ref, intersected with the registry, and applies the family', async () => {
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson({ family: 'trading' }),
      resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
      registryToolNames: new Set(['submit_decision', 'get_price']),
      logger,
      discoverTools: async () => [
        tool('submit_decision', [APPROVED_REF]),
        tool('get_price', [APPROVED_REF]),
        tool('not_in_registry', [APPROVED_REF]),
        tool('other_skill_tool', ['example/skills/other']),
      ],
    });
    const ext = result.resolvedSkills[0]!;
    expect(ext.requiredTools.sort()).toEqual(['get_price', 'submit_decision']); // not_in_registry dropped (∩ registry)
    expect(ext.capabilityFamilies).toEqual(['trading']);
    expect(ext.bindingRequirements).toEqual({ trading: { minBindings: 1, requireReady: true } });
    expect(ext.requiredContextBlocks).toContain('tradingContext');
    expect(result.outcomes[0]?.outcome).toBe('tools_exposed');
  });

  it('hides tools but keeps the skill when the backend is unreachable (EC-11)', async () => {
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson({ family: 'trading' }),
      resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
      registryToolNames: new Set(['submit_decision']),
      logger,
      discoverTools: async () => null, // unreachable
    });
    const ext = result.resolvedSkills[0]!;
    expect(ext.requiredTools).toEqual([]);
    expect(ext.capabilityFamilies).toEqual(['trading']); // family still applied (readiness/guard still fire)
    expect(result.outcomes[0]?.outcome).toBe('backend_unreachable');
  });

  it('leaves an unapproved external skill unchanged (no tools, loadable text)', async () => {
    const discoverTools = vi.fn();
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson(),
      resolvedSkills: [skill({ id: 'ext', sourceRef: 'someone/else/skill' })],
      registryToolNames: new Set(['submit_decision']),
      logger,
      discoverTools,
    });
    expect(result.resolvedSkills[0]?.requiredTools).toEqual([]);
    expect(result.outcomes[0]?.outcome).toBe('not_approved');
    expect(discoverTools).not.toHaveBeenCalled(); // no approved skill → no discovery
  });

  it('leaves system skills (no sourceRef) untouched', async () => {
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson({ family: 'trading' }),
      resolvedSkills: [skill({ id: 'programming', requiredTools: ['execute_code'] })],
      registryToolNames: new Set(['execute_code']),
      logger,
      discoverTools: async () => [],
    });
    expect(result.resolvedSkills[0]?.requiredTools).toEqual(['execute_code']);
    expect(result.outcomes).toHaveLength(0);
  });

  it('a backend with no requiresConnectionFamily exposes tools with no family (EC-12 genericity)', async () => {
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson(), // no family
      resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
      registryToolNames: new Set(['echo']),
      logger,
      discoverTools: async () => [tool('echo', [APPROVED_REF])],
    });
    const ext = result.resolvedSkills[0]!;
    expect(ext.requiredTools).toEqual(['echo']);
    expect(ext.capabilityFamilies).toEqual([]);
    expect(ext.bindingRequirements).toEqual({});
  });
});
