import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
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

const PresetFileSchema = z.object({
  presets: z.record(PresetEntrySchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresetEntry = z.infer<typeof PresetEntrySchema>;
export type StyleKey = 'economy' | 'standard' | 'premium';

// ---------------------------------------------------------------------------
// Path resolution
//
// Prefer HEROBIDS_CONFIG_DIR if set; otherwise use process.cwd().
// STYLE_FILES entries are relative to the project root.
// ---------------------------------------------------------------------------

function resolveConfigPath(relativePath: string): string {
  const configDir = process.env['HEROBIDS_CONFIG_DIR'];
  if (configDir) {
    return `${configDir}/${relativePath}`;
  }
  return `${process.cwd()}/${relativePath}`;
}

const STYLE_FILES: Record<StyleKey, string> = {
  economy: 'config/strategy-presets/economy.yaml',
  standard: 'config/strategy-presets/standard.yaml',
  premium: 'config/strategy-presets/premium.yaml',
};

// ---------------------------------------------------------------------------
// Module-level cache — load once, serve from memory
// ---------------------------------------------------------------------------

let cache: Map<StyleKey, Record<string, PresetEntry>> | null = null;

/**
 * Reset the module-level preset cache.
 * Call after preset YAML files are updated at runtime to force a reload.
 */
export function resetPresetCache(): void {
  cache = null;
}

/**
 * Load and validate all strategy preset YAML files.
 * Results are cached after the first call.
 *
 * @throws {ZodError} on schema validation failure
 * @throws {YAMLParseError} on invalid YAML syntax
 * @throws {NodeJS.ErrnoException} on file read errors (e.g., ENOENT)
 */
export function loadPresets(): Map<StyleKey, Record<string, PresetEntry>> {
  if (cache) return cache;
  cache = new Map();
  for (const [style, relativePath] of Object.entries(STYLE_FILES)) {
    const path = resolveConfigPath(relativePath);
    const raw = readFileSync(path, 'utf-8');
    const parsed = PresetFileSchema.parse(parseYaml(raw));
    cache.set(style as StyleKey, parsed.presets);
  }
  return cache;
}

/**
 * Look up a single preset by strategy key and style.
 */
export function getPreset(strategy: string, style: StyleKey): PresetEntry | undefined {
  return loadPresets().get(style)?.[strategy];
}

/**
 * List all presets for a given style, with the key included.
 */
export function listPresets(style: StyleKey): Array<{ key: string } & PresetEntry> {
  const presets = loadPresets().get(style) ?? {};
  return Object.entries(presets).map(([key, entry]) => ({ key, ...entry }));
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
    positionSize?: string;
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
 * NOTE: DCA presets (strategy.type === 'dca') have no candle/signal
 * parameters and will receive meaningless defaults. This function is
 * intended for technical strategy presets only (momentum, range, swing,
 * scalper, contrarian). Use bots for DCA automation.
 */
export function applyPresetToAgent(
  preset: PresetEntry,
  _mode: 'llm' | 'hybrid',
): AgentPresetMapping {
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
      positionSize:
        typeof p['positionSize'] === 'string' ? (p['positionSize'] as string) : undefined,
      positionSizeMode:
        typeof p['positionSizeMode'] === 'string'
          ? (p['positionSizeMode'] as string)
          : undefined,
    },
  };
}
