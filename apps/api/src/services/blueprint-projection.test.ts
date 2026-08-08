import { describe, it, expect } from 'vitest';
import {
  projectAgentToBlueprintPayload,
  projectBotToBlueprintPayload,
} from './blueprint-projection.js';
import {
  AgentBlueprintRevisionPayloadSchema,
  BotBlueprintRevisionPayloadSchema,
} from '@herobids/domain';

// ── Minimal valid agent projection input ─────────────────────────────────────

const minimalAgentInput = {
  name: 'Test Agent',
  style: null,
  prompt: 'Do trading',
  runtimePolicyOverrides: null,
  toolPolicy: null,
  modelPolicy: null,
  strategy: null,
  risk: null,
  executionDefaults: null,
  unifiedConfig: {
    capabilityMode: 'intelligence' as const,
    intelligence: { provider: 'openai', wakeIntervalMs: 60_000 },
  },
  wakePreferences: null,
  openPositionEscalationToJudgePolicy: 'never',
  capital: null,
  maxBots: null,
  tickIntervalMs: null,
};

// ── Agent projection tests ───────────────────────────────────────────────────

describe('projectAgentToBlueprintPayload', () => {
  it('projects a minimal agent to valid blueprint payload', () => {
    const payload = projectAgentToBlueprintPayload(minimalAgentInput);
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('handles capital "0" correctly (not null)', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      capital: '0',
    });
    expect(payload.capital).toBe(0);
  });

  it('handles capital null correctly', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      capital: null,
    });
    expect(payload.capital).toBeNull();
  });

  it('handles positive capital correctly', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      capital: '5000',
    });
    expect(payload.capital).toBe(5000);
  });

  it('does not include instance-only fields', () => {
    const payload = projectAgentToBlueprintPayload(minimalAgentInput);
    // These are instance-only and must NOT appear in blueprint payloads
    expect((payload as Record<string, unknown>).status).toBeUndefined();
    expect((payload as Record<string, unknown>).telegramChatId).toBeUndefined();
    expect((payload as Record<string, unknown>).blueprintId).toBeUndefined();
    expect((payload as Record<string, unknown>).blueprintRevisionId).toBeUndefined();
    expect((payload as Record<string, unknown>).pauseState).toBeUndefined();
    expect((payload as Record<string, unknown>).notificationPolicy).toBeUndefined();
    expect((payload as Record<string, unknown>).riskOverrides).toBeUndefined();
    expect((payload as Record<string, unknown>).id).toBeUndefined();
    expect((payload as Record<string, unknown>).userId).toBeUndefined();
    expect((payload as Record<string, unknown>).createdAt).toBeUndefined();
    expect((payload as Record<string, unknown>).updatedAt).toBeUndefined();
  });

  it('preserves template-eligible fields from agent input', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      name: 'Custom Bot',
      prompt: 'Execute momentum strategy',
      style: 'aggressive',
      maxBots: 5,
      tickIntervalMs: 30_000,
      openPositionEscalationToJudgePolicy: 'always',
    });
    expect(payload.name).toBe('Custom Bot');
    expect(payload.prompt).toBe('Execute momentum strategy');
    expect(payload.style).toBe('aggressive');
    expect(payload.maxBots).toBe(5);
    expect(payload.tickIntervalMs).toBe(30_000);
    expect(payload.openPositionEscalationToJudgePolicy).toBe('always');
  });

  it('projects strategy and risk fields when provided', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      strategy: { type: 'momentum', decisionMode: 'mechanical', params: {} },
      risk: { maxPositionSizePct: 10, dailyMaxLossPct: 5 },
      executionDefaults: { mode: 'paper', slippageBps: 50 },
    });
    expect(payload.strategy).toEqual({ type: 'momentum', decisionMode: 'mechanical', params: {} });
    expect(payload.risk).toEqual({ maxPositionSizePct: 10, dailyMaxLossPct: 5 });
    expect(payload.executionDefaults).toEqual({ mode: 'paper', slippageBps: 50 });
  });

  it('defaults capabilityMode to intelligence when not explicitly set', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      unifiedConfig: { intelligence: { provider: 'openai', wakeIntervalMs: 60_000 } },
    });
    expect(payload.capabilityMode).toBe('intelligence');
  });

  it('projects agent with executionDefaults.slippageBps: null to a valid blueprint payload', () => {
    const payload = projectAgentToBlueprintPayload({
      ...minimalAgentInput,
      executionDefaults: { mode: 'paper', slippageBps: null },
    });
    const result = AgentBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// ── Bot projection tests ─────────────────────────────────────────────────────

describe('projectBotToBlueprintPayload', () => {
  const minimalBotInput = {
    name: 'Test Bot',
    config: {
      strategy: { type: 'dca' as const } as Record<string, unknown>,
      risk: { maxPositionSizePct: 10 } as Record<string, unknown>,
      execution: { mode: 'paper' as const, slippageBps: 50 } as Record<string, unknown>,
      venue: 'hyperliquid',
      venueType: 'orderbook',
      symbol: 'BTC-USD',
      shadowPollIntervalMs: 2000,
    },
  };

  it('projects a bot config to valid blueprint payload', () => {
    const payload = projectBotToBlueprintPayload(minimalBotInput);
    const result = BotBlueprintRevisionPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('preserves all bot config fields', () => {
    const payload = projectBotToBlueprintPayload(minimalBotInput);
    expect(payload.name).toBe('Test Bot');
    expect(payload.venue).toBe('hyperliquid');
    expect(payload.venueType).toBe('orderbook');
    expect(payload.symbol).toBe('BTC-USD');
    expect(payload.shadowPollIntervalMs).toBe(2000);
  });

  it('handles missing optional config fields with defaults', () => {
    const payload = projectBotToBlueprintPayload({
      name: 'Minimal Bot',
      config: {},
    });
    expect(payload.description).toBe('');
    expect(payload.tags).toEqual([]);
    expect(payload.venue).toBe('');
    expect(payload.symbol).toBe('');
    expect(payload.shadowPollIntervalMs).toBe(2000);
  });

  it('passes through swap assets when provided', () => {
    const payload = projectBotToBlueprintPayload({
      name: 'Swap Bot',
      config: {
        strategy: { type: 'dca' },
        risk: {},
        execution: { mode: 'paper' },
        venue: 'jupiter',
        venueType: 'swap',
        symbol: 'SOL/USDC',
        swapAssets: { baseAsset: 'SOL', quoteAsset: 'USDC', baseDecimals: 9, quoteDecimals: 6 },
      },
    });
    expect(payload.swapAssets).toEqual({
      baseAsset: 'SOL',
      quoteAsset: 'USDC',
      baseDecimals: 9,
      quoteDecimals: 6,
    });
  });

  it('does not include instance-only fields', () => {
    const payload = projectBotToBlueprintPayload(minimalBotInput);
    expect((payload as Record<string, unknown>).venueAccountId).toBeUndefined();
    expect((payload as Record<string, unknown>).connectionId).toBeUndefined();
    expect((payload as Record<string, unknown>).status).toBeUndefined();
    expect((payload as Record<string, unknown>).blueprintId).toBeUndefined();
    expect((payload as Record<string, unknown>).blueprintRevisionId).toBeUndefined();
  });
});
