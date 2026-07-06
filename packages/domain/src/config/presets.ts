import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas — validate YAML at the boundary, trust types internally
// ---------------------------------------------------------------------------

export const PresetEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  strategy: z.object({
    type: z.string(),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).default('mechanical'),
    params: z.record(z.unknown()),
  }),
  risk: z
    .object({
      maxPositionSizePct: z.number().min(0).max(100).optional(),
    })
    .optional(),
  execution: z
    .object({
      mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
    })
    .optional(),
});

export const PresetFileSchema = z.object({
  presets: z.record(PresetEntrySchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresetEntry = z.infer<typeof PresetEntrySchema>;
export type StyleKey = 'economy' | 'standard' | 'premium';

// ---------------------------------------------------------------------------
// Agent style → preset style mapping
// ---------------------------------------------------------------------------

/**
 * Map an agent personality style to the corresponding preset style tier.
 */
export function agentStyleToPresetStyle(agentStyle: string): StyleKey {
  switch (agentStyle) {
    case 'careful':
      return 'economy';
    case 'balanced':
      return 'standard';
    case 'bold':
      return 'premium';
    default:
      return 'standard';
  }
}

// ---------------------------------------------------------------------------
// Preset → agent config split
// ---------------------------------------------------------------------------

export const AGENT_TECHNICAL_STRATEGY_TYPES = [
  'momentum',
  'momentum-position',
  'range',
  'swing',
  'scalper',
  'contrarian',
] as const;

export type AgentTechnicalStrategyType = (typeof AGENT_TECHNICAL_STRATEGY_TYPES)[number];

export interface AgentPresetMapping {
  technical: {
    indicators: Record<string, unknown>;
    candles: { interval: string; limit: number };
    signalBias: string;
    scanIntervalMs?: number;
  };
  risk: {
    stopLossPct?: number;
    maxPositionSizePct?: number;
  };
  execution: {
    /** Maps to UnifiedAgentConfigSchema.execution.fixedPositionSize */
    fixedPositionSize?: string;
    positionSizeMode?: string;
  };
}

/**
 * Split a preset into the three sections an agent needs:
 * technical, risk, and execution.
 *
 * The `mode` parameter is reserved for future use (llm vs hybrid selection)
 * but does not currently alter the output.
 *
 * DCA presets (strategy.type === 'dca') are rejected with an error since
 * DCA is bot-only for this preset system. Only technical strategy presets
 * (momentum, range, swing, scalper, contrarian) are supported for agents.
 */
export function applyPresetToAgent(
  preset: PresetEntry,
  _mode: 'llm' | 'hybrid',
): AgentPresetMapping {
  const type = preset.strategy.type;
  if (type === 'dca') {
    throw new Error(
      `Preset type "dca" is not supported for agents. ` +
      `DCA is a bot-only strategy. Supported agent strategies: ${AGENT_TECHNICAL_STRATEGY_TYPES.join(', ')}.`,
    );
  }

  const p = preset.strategy.params as Record<string, unknown>;
  return {
    technical: {
      indicators: (p['indicators'] as Record<string, unknown>) ?? {},
      candles: {
        interval: String(p['candleInterval'] ?? '15m'),
        limit: Number(p['candleLimit'] ?? 48),
      },
      signalBias: String(p['signalBias'] ?? 'trend-following'),
      scanIntervalMs:
        typeof p['scanIntervalMs'] === 'number'
          ? (p['scanIntervalMs'] as number)
          : undefined,
    },
    risk: {
      stopLossPct:
        typeof p['stopLossPct'] === 'number' ? (p['stopLossPct'] as number) : undefined,
      maxPositionSizePct: preset.risk?.maxPositionSizePct,
    },
    execution: {
      fixedPositionSize:
        typeof p['positionSize'] === 'string' ? (p['positionSize'] as string) : undefined,
      positionSizeMode:
        typeof p['positionSizeMode'] === 'string'
          ? (p['positionSizeMode'] as string)
          : undefined,
    },
  };
}
