import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PresetFileSchema, type PresetEntry, type StyleKey } from './presets.js';

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
  const loading = new Map<StyleKey, Record<string, PresetEntry>>();
  try {
    for (const [style, relativePath] of Object.entries(STYLE_FILES)) {
      const path = resolveConfigPath(relativePath);
      const raw = readFileSync(path, 'utf-8');
      const parsed = PresetFileSchema.parse(parseYaml(raw));
      loading.set(style as StyleKey, parsed.presets);
    }
  } catch (error) {
    cache = null;
    throw error;
  }
  cache = loading;
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
