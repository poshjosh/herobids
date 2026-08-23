import crypto from 'node:crypto';
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

/**
 * Type-narrowing guard: checks whether a string is a valid StyleKey.
 */
export function isStyleKey(s: string): s is StyleKey {
  return s === 'economy' || s === 'standard' || s === 'premium';
}

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
  /** The preset key (e.g., "momentum", "scalper") from the presets YAML. */
  presetKey: string;
  /** The style tier this preset belongs to (economy, standard, premium). */
  presetStyle: string;
  /**
   * Deterministic behavior version derived mechanically from behavior-affecting
   * preset fields. Non-material changes (display name, description) are excluded.
   * 12-character hex prefix of SHA-256.
   */
  presetBehaviorVersion: string;
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
 * Extract only the behavior-affecting fields from a preset entry.
 * Excludes display name and description — those are non-material for
 * behavior versioning.
 */
export function extractBehaviorFields(preset: PresetEntry): Record<string, unknown> {
  return {
    strategyType: preset.strategy.type,
    decisionMode: preset.strategy.decisionMode,
    params: preset.strategy.params,
    risk: preset.risk ?? null,
    execution: preset.execution ?? null,
  };
}

/**
 * Serialize a value to a deterministic JSON string with recursively sorted keys.
 * Unlike JSON.stringify with an array replacer (which filters nested objects),
 * this preserves all values while ensuring canonical key ordering at every level.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Compute a deterministic behavior version for a preset from its
 * behavior-affecting fields only. Non-material changes (display name,
 * description, documentation) are excluded.
 *
 * The version is a 12-character hex prefix of a SHA-256 hash of the
 * canonical JSON representation (sorted keys) of the behavior fields.
 */
export function computePresetBehaviorVersion(preset: PresetEntry): string {
  const behaviorFields = extractBehaviorFields(preset);
  const canonical = stableJson(behaviorFields);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
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
  presetKey: string,
  preset: PresetEntry,
  presetStyle: StyleKey,
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
    presetKey,
    presetStyle,
    presetBehaviorVersion: computePresetBehaviorVersion(preset),
    technical: {
      indicators: (p['indicators'] as Record<string, unknown>) ?? {},
      candles: {
        interval: String(p['candleInterval'] ?? '15m').toLowerCase(),
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
