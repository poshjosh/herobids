import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SKILL, KNOWN_AGENT_TOOL_NAMES, SYSTEM_SKILLS, PROGRAMMING_SKILL, FILE_MANAGEMENT_SKILL } from '@herobids/domain';
import type { AgentTool, ToolContext } from '@herobids/domain';
import { botManagementTools } from './bots.js';
import { ToolRegistry, convertZodToJsonSchema } from './registry.js';
import { createToolRegistry } from './index.js';
import { messagingTools } from './messaging.js';
import { marketDataTools } from './market-data.js';
import { tradingTools } from './trading.js';
import { filesystemTools } from './filesystem.js';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase: 'scout',
    executionMode: 'paper',
    redis: {
      hset: vi.fn(async () => 1),
      hget: vi.fn(async () => null),
      publish: vi.fn(async () => 1),
    },
    publishToInbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('tool registry extracted tools', () => {
  it('registers create_bot only through bot-management tools', () => {
    expect(tradingTools.map((tool) => tool.name)).not.toContain('create_bot');

    const createBotTool = botManagementTools.find((tool) => tool.name === 'create_bot');
    expect(createBotTool).toBeDefined();

    const registry = createToolRegistry();
    expect(registry.get('create_bot')).toBe(createBotTool);
  });

  it('rejects duplicate tool registrations', () => {
    const registry = new ToolRegistry();
    const duplicateTool: AgentTool = {
      name: 'duplicate_tool',
      description: 'Test duplicate registration behavior.',
      parametersSchema: z.object({}),
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      category: 'write-messaging',
      async execute() {
        return { success: true };
      },
    };

    registry.register(duplicateTool);

    expect(() => registry.register(duplicateTool)).toThrow('Duplicate tool registration');
  });

  it('accepts RegimeParams-shaped input for check_regime', async () => {
    const checkRegimeTool = marketDataTools.find((tool) => tool.name === 'check_regime');
    expect(checkRegimeTool).toBeDefined();

    const result = await checkRegimeTool!.execute({
      benchmarkSymbol: 'BTCUSDT',
      emaFast: 20,
      emaSlow: 50,
      emaTrend: 200,
      adxMin: 20,
      emaAlignment: 'bullish',
      priceAboveVwap: true,
      disableWhenChoppy: true,
    }, createToolContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe('market_data_not_configured');
  });

  it('keeps normalized optional params out of emitted required arrays', () => {
    const submitDecisionTool = tradingTools.find((tool) => tool.name === 'submit_decision');
    const createBotTool = botManagementTools.find((tool) => tool.name === 'create_bot');
    const checkRegimeTool = marketDataTools.find((tool) => tool.name === 'check_regime');

    expect(submitDecisionTool).toBeDefined();
    expect(createBotTool).toBeDefined();
    expect(checkRegimeTool).toBeDefined();

    const submitDecisionRequired = ((submitDecisionTool!.parameters as { required?: string[] }).required ?? []).slice().sort();
    const createBotRequired = ((createBotTool!.parameters as { required?: string[] }).required ?? []).slice().sort();
    const checkRegimeRequired = ((checkRegimeTool!.parameters as { required?: string[] }).required ?? []).slice().sort();

    expect(submitDecisionRequired).toEqual(['instrumentId', 'intent', 'rationaleSummary', 'targetSize']);
    expect(createBotRequired).toEqual([]);
    expect(checkRegimeRequired).toEqual([]);
  });

  it('publishes a protocol-valid default summary for publish_artifact', async () => {
    const publishArtifactTool = messagingTools.find((tool) => tool.name === 'publish_artifact');
    expect(publishArtifactTool).toBeDefined();

    const publishToInbound = vi.fn(async () => undefined);
    // Simulate centralized validation: schema applies the `.default('Artifact published')`.
    const parsedParams = publishArtifactTool!.parametersSchema.parse({
      artifactType: 'chart',
      contentType: 'image/png',
    });
    const result = await publishArtifactTool!.execute(parsedParams, createToolContext({ publishToInbound }));

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
    expect(publishToInbound).toHaveBeenCalledWith(
      'agent.artifact.publish',
      expect.objectContaining({ summary: 'Artifact published' }),
    );
  });

  it('registers execute_code as the canonical code execution tool', () => {
    const registry = createToolRegistry();

    expect(registry.has('execute_code')).toBe(true);
    expect(registry.has('code_execute')).toBe(false);
  });

  it('matches the shared agent tool catalog exactly', () => {
    const registry = createToolRegistry();
    const registryToolNames = registry.list().map((tool) => tool.name).sort();

    expect(registryToolNames).toEqual([...KNOWN_AGENT_TOOL_NAMES].sort());
  });

  it('only exposes known tools from built-in skills', () => {
    const knownToolNames = new Set(KNOWN_AGENT_TOOL_NAMES);

    for (const skill of [BASE_SKILL, ...SYSTEM_SKILLS]) {
      expect(skill.requiredTools.every((toolName) => knownToolNames.has(toolName))).toBe(true);
    }
  });

  it('registry includes all five programming-related tools', () => {
    const registry = createToolRegistry();
    for (const name of ['execute_code', 'write_file', 'read_file', 'list_files', 'delete_file']) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('PROGRAMMING_SKILL requiredTools all resolve against registered tools', () => {
    const registry = createToolRegistry();
    for (const toolName of PROGRAMMING_SKILL.requiredTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });

  it('FILE_MANAGEMENT_SKILL requiredTools all resolve against registered tools', () => {
    const registry = createToolRegistry();
    for (const toolName of FILE_MANAGEMENT_SKILL.requiredTools) {
      expect(registry.has(toolName)).toBe(true);
    }
  });

  it('shared tool catalog includes all filesystem tool names', () => {
    const knownToolNames = new Set(KNOWN_AGENT_TOOL_NAMES as readonly string[]);
    for (const tool of filesystemTools) {
      expect(knownToolNames.has(tool.name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// convertZodToJsonSchema — JSON Schema draft compatibility
// ---------------------------------------------------------------------------
// These tests guard against Draft 4 boolean exclusiveMinimum/Maximum leaking
// into tool schemas. Providers such as DeepSeek follow Draft 7, where those
// keywords must be numbers, and return a 400 when they are booleans.

describe('convertZodToJsonSchema draft normalisation', () => {
  it('emits numeric exclusiveMinimum (Draft 7) for z.number().positive()', () => {
    const schema = convertZodToJsonSchema(z.object({
      days: z.number().int().positive().optional(),
    }));

    function findExclusiveMinimum(node: unknown): unknown {
      if (node === null || typeof node !== 'object') return undefined;
      if ('exclusiveMinimum' in (node as object)) return (node as Record<string, unknown>)['exclusiveMinimum'];
      for (const v of Object.values(node as object)) {
        const found = findExclusiveMinimum(v);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    const value = findExclusiveMinimum(schema);
    expect(value).not.toBeUndefined();
    expect(typeof value).toBe('number');
  });

  it('emits numeric exclusiveMaximum (Draft 7) for z.number().negative()', () => {
    const schema = convertZodToJsonSchema(z.object({
      threshold: z.number().negative().optional(),
    }));

    function findExclusiveMaximum(node: unknown): unknown {
      if (node === null || typeof node !== 'object') return undefined;
      if ('exclusiveMaximum' in (node as object)) return (node as Record<string, unknown>)['exclusiveMaximum'];
      for (const v of Object.values(node as object)) {
        const found = findExclusiveMaximum(v);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    const value = findExclusiveMaximum(schema);
    expect(value).not.toBeUndefined();
    expect(typeof value).toBe('number');
  });

  it('produces no boolean exclusiveMinimum or exclusiveMaximum across all registered tools', () => {
    const registry = createToolRegistry();
    const violations: string[] = [];

    function scan(node: unknown, path: string): void {
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj['exclusiveMinimum'] === true || obj['exclusiveMaximum'] === true) {
        violations.push(path);
      }
      for (const [k, v] of Object.entries(obj)) {
        scan(v, `${path}.${k}`);
      }
    }

    for (const tool of registry.list()) {
      scan(tool.parameters, tool.name);
    }

    expect(violations).toEqual([]);
  });
});