import type { TickThinkingLevel } from './tick-thinking.js';

export type CostPreset = 'minimal' | 'standard' | 'premium' | 'custom';

export interface AgentCostProfileInput {
  provider: string;
  heavyModel: string;
  lightModel: string;
  costPreset?: CostPreset;
  dailyBudgetUsd?: number;
  baseTickIntervalMs: number;
}

export interface AgentCostProfile {
  preset: CostPreset;
  dailyBudgetUsd: number;
  heavyModel: string;
  lightModel: string;
  tickIntervalMs: number;
  enabledGates: {
    session: boolean;
    regime: boolean;
    contextHash: boolean;
    adaptiveInterval: boolean;
  };
  defaultThinking: TickThinkingLevel;
}

function deriveCustomTickIntervalMs(dailyBudgetUsd: number): number {
  const estimatedCostPerTick = dailyBudgetUsd <= 3 ? 0.002 : dailyBudgetUsd <= 10 ? 0.01 : 0.05;
  const ticksPerDay = Math.max(1, Math.floor(dailyBudgetUsd / estimatedCostPerTick));
  return Math.max(300_000, Math.round(86_400_000 / ticksPerDay));
}

export function resolveAgentCostProfile(input: AgentCostProfileInput): AgentCostProfile {
  const lightModel = input.lightModel;
  const heavyModel = input.heavyModel;

  switch (input.costPreset) {
    case 'minimal':
      return {
        preset: 'minimal',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 3,
        heavyModel: lightModel,
        lightModel,
        tickIntervalMs: 1_800_000,
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: 'none',
      };
    case 'standard':
      return {
        preset: 'standard',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 10,
        heavyModel,
        lightModel,
        tickIntervalMs: 900_000,
        enabledGates: { session: false, regime: true, contextHash: true, adaptiveInterval: false },
        defaultThinking: 'light',
      };
    case 'premium':
      return {
        preset: 'premium',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 30,
        heavyModel,
        lightModel,
        tickIntervalMs: 300_000,
        enabledGates: { session: false, regime: false, contextHash: true, adaptiveInterval: false },
        defaultThinking: 'deep',
      };
    case 'custom':
      return {
        preset: 'custom',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 5,
        heavyModel: (input.dailyBudgetUsd ?? 5) <= 3 ? lightModel : heavyModel,
        lightModel,
        tickIntervalMs: deriveCustomTickIntervalMs(input.dailyBudgetUsd ?? 5),
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: (input.dailyBudgetUsd ?? 5) <= 3 ? 'none' : 'light',
      };
    default:
      return {
        preset: 'standard',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 10,
        heavyModel,
        lightModel,
        tickIntervalMs: input.baseTickIntervalMs,
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: 'light',
      };
  }
}