export type TickThinkingLevel = 'none' | 'light' | 'deep';

export type CostPreset = 'minimal' | 'standard' | 'premium' | 'custom';

export interface AgentCostProfileInput {
  provider: string;
  heavyModel: string;
  lightModel: string;
  costPreset?: CostPreset;
  dailyBudgetUsd?: number;
  baseTickIntervalMs: number;
  /** User-configured base cadence in ms. When present, overrides the preset-derived interval. */
  tickIntervalMs?: number;
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

/** Preset-derived base tick intervals in milliseconds (mirrors agent-cadence.ts). */
const PRESET_TICK_INTERVALS = {
  minimal: 5_400_000,
  standard: 1_800_000,
  premium: 600_000,
} as const;

// Cost-per-tick estimates by usage tier (from agentCostEstimates config).
const COST_PER_TICK = { minimal: 0.12, standard: 0.21, premium: 0.31 };

function deriveCustomTickIntervalMs(dailyBudgetUsd: number): number {
  const estimatedCostPerTick = dailyBudgetUsd <= 3 ? COST_PER_TICK.minimal : dailyBudgetUsd <= 10 ? COST_PER_TICK.standard : COST_PER_TICK.premium;
  const ticksPerDay = Math.max(1, Math.floor(dailyBudgetUsd / estimatedCostPerTick));
  return Math.max(300_000, Math.round(86_400_000 / ticksPerDay));
}

export function resolveAgentCostProfile(input: AgentCostProfileInput): AgentCostProfile {
  const lightModel = input.lightModel;
  const heavyModel = input.heavyModel;

  let profile: AgentCostProfile;

  switch (input.costPreset) {
    case 'minimal':
      profile = {
        preset: 'minimal',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 3,
        heavyModel: lightModel,
        lightModel,
        tickIntervalMs: PRESET_TICK_INTERVALS.minimal,
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: 'none',
      };
      break;
    case 'standard':
      profile = {
        preset: 'standard',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 10,
        heavyModel,
        lightModel,
        tickIntervalMs: PRESET_TICK_INTERVALS.standard,
        enabledGates: { session: false, regime: true, contextHash: true, adaptiveInterval: false },
        defaultThinking: 'light',
      };
      break;
    case 'premium':
      profile = {
        preset: 'premium',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 30,
        heavyModel,
        lightModel,
        tickIntervalMs: PRESET_TICK_INTERVALS.premium,
        enabledGates: { session: false, regime: false, contextHash: true, adaptiveInterval: false },
        defaultThinking: 'deep',
      };
      break;
    case 'custom':
      profile = {
        preset: 'custom',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 5,
        heavyModel: (input.dailyBudgetUsd ?? 5) <= 3 ? lightModel : heavyModel,
        lightModel,
        tickIntervalMs: deriveCustomTickIntervalMs(input.dailyBudgetUsd ?? 5),
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: (input.dailyBudgetUsd ?? 5) <= 3 ? 'none' : 'light',
      };
      break;
    default:
      profile = {
        preset: 'standard',
        dailyBudgetUsd: input.dailyBudgetUsd ?? 10,
        heavyModel,
        lightModel,
        tickIntervalMs: input.baseTickIntervalMs,
        enabledGates: { session: true, regime: true, contextHash: true, adaptiveInterval: true },
        defaultThinking: 'light',
      };
  }

  // Explicit user-configured tick interval wins over the preset-derived value.
  // Runtime adaptive slowdown still applies on top of this base cadence.
  if (input.tickIntervalMs != null && input.tickIntervalMs > 0) {
    profile = { ...profile, tickIntervalMs: input.tickIntervalMs };
  }

  return profile;
}
