// Integration of the strategy preset proxies with the pieces around them: the real
// tool registry, backend tool visibility, the runtime visibility controller, and the
// real write binding + client against a fake idempotent Traderton boundary.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RuntimeDescriptor, SkillDefinition, TradingToolContext } from '@herobids/domain';
import {
  createExternalBackendClient,
  type DiscoveredBackendTool,
  type ExternalBackendSubject,
} from '@herobids/domain/external-backend';
import { createToolRegistry } from './index.js';
import { buildBackendToolVisibility } from '../external-backend/backend-tool-visibility.js';
import { createRuntimeToolVisibilityController } from '../runtime-tool-visibility.js';
import {
  createExternalBackendWriteBoundary,
  createSubjectBoundWriteBoundary,
} from '../external-backend/write-adapter.js';
import { startFakeIdempotentBoundary, type FakeIdempotentBoundary } from '../external-backend/__tests__/fake-idempotent-boundary.js';

const CRYPTO_TRADING_REF = 'traderton/skills/crypto-trading';
const PRESET_TOOLS = ['list_strategy_presets', 'assess_strategy_preset', 'change_strategy_preset'];

function loadCryptoTradingTools(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../external-backend/__fixtures__/traderton-skill-tools.json', import.meta.url), 'utf8'),
  );
  const skills = (parsed as { skills: Record<string, string[]> }).skills;
  const names = skills[CRYPTO_TRADING_REF];
  if (!names) throw new Error('fixture has no crypto-trading skill');
  return names;
}

function backendConfigJson(): string {
  return JSON.stringify({
    definition: {
      backendId: 'traderton',
      endpoint: {
        baseUrl: 'http://localhost:8080',
        mcpPath: '/internal/v1/mcp',
        discoveryRetry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      caller: { consumerId: 'herobids', keyId: 'current', hmacSecretRef: 'TRADERTON_HMAC_SECRET' },
      approvedSourceSkillRefs: [CRYPTO_TRADING_REF],
      requiresConnectionFamily: 'trading',
    },
    hmacSecret: 'secret',
  });
}

function externalSkill(): SkillDefinition {
  return {
    id: 'crypto-trading',
    name: 'crypto-trading',
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
    sourceRef: CRYPTO_TRADING_REF,
  };
}

describe('strategy preset tools in the runtime visibility chain', () => {
  it('keeps the three preset tools allowed after discovery and a tick-time visibility pass', async () => {
    const tagged = loadCryptoTradingTools();
    const discovered: DiscoveredBackendTool[] = tagged.map((name) => ({
      name,
      description: `d:${name}`,
      inputSchema: { type: 'object' },
      skillRefs: [CRYPTO_TRADING_REF],
    }));
    const registryNames = new Set(createToolRegistry().list().map((tool) => tool.name));

    const visibility = await buildBackendToolVisibility({
      rawConfigJson: backendConfigJson(),
      resolvedSkills: [externalSkill()],
      registryToolNames: registryNames,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      discoverTools: async () => discovered,
    });
    expect(visibility.outcomes[0]?.droppedTools).toEqual([]);

    const descriptor = {
      schemaVersion: 'v1',
      agentId: 'agent-1',
      goal: 'trade',
      executionMode: 'paper',
      resolvedSkills: visibility.resolvedSkills,
      grantedConnectionsByFamily: {},
      defaultConnectionByFamily: {},
      readinessByFamily: {},
      toolPolicy: {},
      guardrails: {},
      budgets: {
        maxHistoryMessages: 20,
        maxRecentToolMessages: 6,
        maxToolResultChars: 4_000,
        maxVisibleToolSchemas: 100,
        maxContextBlockChars: 4_000,
      },
    } as RuntimeDescriptor;
    const controller = createRuntimeToolVisibilityController(() => descriptor, new Set());

    controller.applyToolVisibility();

    const allowed = controller.allowedTools();
    for (const name of PRESET_TOOLS) {
      expect(allowed.has(name), `${name} is visible but denied`).toBe(true);
      expect(registryNames.has(name)).toBe(true);
    }
  });
});

describe('change_strategy_preset over the real write binding', () => {
  const SUBJECT: ExternalBackendSubject = { ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } };
  const INPUT = {
    assessmentArtifactId: 'artifact-1',
    targetPreset: 'trend-follower',
    mode: 'entries_only',
    reason: 'Trend flags are strong.',
  };
  let backend: FakeIdempotentBoundary | undefined;

  afterEach(async () => {
    await backend?.close();
    backend = undefined;
  });

  async function openCtx(): Promise<{ ctx: TradingToolContext; fake: FakeIdempotentBoundary }> {
    const fake = await startFakeIdempotentBoundary();
    backend = fake;
    const client = createExternalBackendClient({
      baseUrl: fake.url,
      consumerId: 'herobids-integration',
      keyId: 'integration',
      hmacSecret: 'integration-secret',
      requestTimeoutMs: 5_000,
    });
    const ctx = {
      agentId: 'agent-1',
      sessionId: 'session-1',
      externalBackendWrite: createSubjectBoundWriteBoundary(createExternalBackendWriteBoundary(client), SUBJECT),
      selectedVenueAccountResolver: async () => ({ status: 'ready' as const, venueAccountId: 'venue-account-1' }),
    } as TradingToolContext;
    return { ctx, fake };
  }

  async function callChange(ctx: TradingToolContext) {
    const tool = createToolRegistry().get('change_strategy_preset');
    if (!tool) throw new Error('change_strategy_preset is not registered');
    return tool.execute(tool.parametersSchema.parse(INPUT), ctx);
  }

  it('executes once when the response is lost and the same-key re-issue recovers it', async () => {
    const { ctx, fake } = await openCtx();
    fake.loseNextResponseAfterExecution();

    const result = await callChange(ctx);

    expect(result.success).toBe(true);
    expect(fake.executions('change_strategy_preset')).toBe(1);
  });

  it('treats a second tool call as a new logical write with a new idempotency key', async () => {
    const { ctx, fake } = await openCtx();

    const first = await callChange(ctx);
    const second = await callChange(ctx);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(fake.executions('change_strategy_preset')).toBe(2);
  });
});
