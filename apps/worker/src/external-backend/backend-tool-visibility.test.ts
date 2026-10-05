// Phase 4 T8 — backend-approved tool visibility over MCP discovery.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import type { DiscoveredBackendTool } from '@herobids/domain/external-backend';
import { buildBackendToolVisibility } from './backend-tool-visibility.js';

const DEFAULT_UNREACHABLE = { kind: 'unreachable' as const, message: 'HTTP 404: route not found' };

// Only the default (no `discoverTools` override) path reaches this; every other
// test injects its own discovery. The retry-focused describe block below
// overrides this per-test with mockResolvedValueOnce chains; restored after
// each test so unrelated tests keep seeing the stable default.
vi.mock('@herobids/domain/external-backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@herobids/domain/external-backend')>()),
  discoverExternalBackendTools: vi.fn(async () => DEFAULT_UNREACHABLE),
}));

afterEach(async () => {
  const { discoverExternalBackendTools } = await import('@herobids/domain/external-backend');
  vi.mocked(discoverExternalBackendTools).mockReset().mockResolvedValue(DEFAULT_UNREACHABLE);
});

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

function resolvedConfigJson(opts: { family?: string; discoveryRetry?: Record<string, number> } = {}): string {
  return JSON.stringify({
    definition: {
      backendId: 'example-echo',
      endpoint: {
        baseUrl: 'http://localhost:8080',
        mcpPath: '/internal/v1/mcp',
        // Fast, deterministic retry timing for tests that exercise the real
        // discoverViaMcp path — avoids real backoff delays slowing the suite.
        discoveryRetry: opts.discoveryRetry ?? { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
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

  it('logs why MCP discovery failed when the backend is unreachable', async () => {
    const warn = vi.fn();
    const result = await buildBackendToolVisibility({
      rawConfigJson: resolvedConfigJson({ family: 'trading' }),
      resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
      registryToolNames: new Set(['submit_decision']),
      logger: { info: vi.fn(), warn },
    });
    expect(result.outcomes[0]?.outcome).toBe('backend_unreachable');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ backendId: 'example-echo', mcpPath: '/internal/v1/mcp', attempts: 1, reason: 'HTTP 404: route not found' }),
      'Backend tool visibility: MCP tools/list discovery failed',
    );
  });

  describe('discovery retry (docs/features/2026/10/05/001-backend-tool-discovery-retry)', () => {
    it('recovers after a transient discovery failure within the retry budget', async () => {
      const { discoverExternalBackendTools } = await import('@herobids/domain/external-backend');
      vi.mocked(discoverExternalBackendTools)
        .mockResolvedValueOnce({ kind: 'unreachable', message: 'connect timeout' })
        .mockResolvedValueOnce({ kind: 'ok', tools: [tool('submit_decision', [APPROVED_REF])] });

      const info = vi.fn();
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ family: 'trading', discoveryRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
        resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
        registryToolNames: new Set(['submit_decision']),
        logger: { info, warn: vi.fn() },
      });

      expect(result.outcomes[0]?.outcome).toBe('tools_exposed');
      expect(result.resolvedSkills[0]?.requiredTools).toEqual(['submit_decision']);
      expect(discoverExternalBackendTools).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ backendId: 'example-echo', attempt: 2, maxAttempts: 3 }),
        'Backend tool visibility: retrying MCP tools/list discovery',
      );
    });

    it('reports backend_unreachable only after exhausting the configured retry budget', async () => {
      const { discoverExternalBackendTools } = await import('@herobids/domain/external-backend');
      vi.mocked(discoverExternalBackendTools).mockResolvedValue({ kind: 'unreachable', message: 'connect timeout' });

      const warn = vi.fn();
      const result = await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ family: 'trading', discoveryRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
        resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
        registryToolNames: new Set(['submit_decision']),
        logger: { info: vi.fn(), warn },
      });

      expect(result.outcomes[0]?.outcome).toBe('backend_unreachable');
      expect(discoverExternalBackendTools).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ backendId: 'example-echo', attempts: 3, reason: 'connect timeout' }),
        'Backend tool visibility: MCP tools/list discovery failed',
      );
    });

    it('does not log a retry attempt when the first attempt succeeds', async () => {
      const { discoverExternalBackendTools } = await import('@herobids/domain/external-backend');
      vi.mocked(discoverExternalBackendTools).mockResolvedValue({ kind: 'ok', tools: [tool('submit_decision', [APPROVED_REF])] });

      const info = vi.fn();
      await buildBackendToolVisibility({
        rawConfigJson: resolvedConfigJson({ family: 'trading', discoveryRetry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } }),
        resolvedSkills: [skill({ id: 'ext', sourceRef: APPROVED_REF })],
        registryToolNames: new Set(['submit_decision']),
        logger: { info, warn: vi.fn() },
      });

      expect(discoverExternalBackendTools).toHaveBeenCalledTimes(1);
      // The success-path "approved skill tools resolved" info log is expected
      // (asserted elsewhere); only the retry-attempt log must be absent here.
      expect(info).not.toHaveBeenCalledWith(
        expect.anything(),
        'Backend tool visibility: retrying MCP tools/list discovery',
      );
    });
  });
});
