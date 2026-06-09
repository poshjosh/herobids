import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@herobids/domain';
import { messagingTools } from './messaging.js';
import { marketDataTools } from './market-data.js';

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

  it('publishes a protocol-valid default summary for artifact_publish', async () => {
    const artifactPublishTool = messagingTools.find((tool) => tool.name === 'artifact_publish');
    expect(artifactPublishTool).toBeDefined();

    const publishToInbound = vi.fn(async () => undefined);
    // Simulate centralized validation: schema applies the `.default('Artifact published')`.
    const parsedParams = artifactPublishTool!.parametersSchema.parse({
      artifactType: 'chart',
      contentType: 'image/png',
    });
    const result = await artifactPublishTool!.execute(parsedParams, createToolContext({ publishToInbound }));

    expect(result.success).toBe(true);
    expect(publishToInbound).toHaveBeenCalledTimes(1);
    expect(publishToInbound).toHaveBeenCalledWith(
      'agent.artifact.publish',
      expect.objectContaining({ summary: 'Artifact published' }),
    );
  });
});