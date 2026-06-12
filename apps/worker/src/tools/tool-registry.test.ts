import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { BASE_SKILL, KNOWN_AGENT_TOOL_NAMES, SYSTEM_SKILLS, PROGRAMMING_SKILL, FILE_MANAGEMENT_SKILL } from '@herobids/domain';
import type { AgentTool, ToolContext } from '@herobids/domain';
import { botManagementTools } from './bots.js';
import { ToolRegistry } from './registry.js';
import { createToolRegistry } from './index.js';
import { messagingTools } from './messaging.js';
import { marketDataTools } from './market-data.js';
import { tradingTools } from './trading.js';
import { filesystemTools } from './filesystem.js';

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
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