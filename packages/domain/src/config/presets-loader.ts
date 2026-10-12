import { z } from 'zod';
import { PresetEntrySchema, type PresetEntry, type StyleKey } from './presets.js';

// ---------------------------------------------------------------------------
// Boundary-seeded preset catalog (D2-a Option 1).
//
// Herobids no longer reads the preset YAML files directly — traderton is the
// sole authority for the preset definitions and serves them over the
// `get_strategy_presets` read tool. The API seeds this module-level cache at
// startup (see `apps/api/src/traderton-presets.ts`); `getPreset` / `listPresets`
// stay synchronous and read from the cache so the existing create/blueprint
// call sites are unchanged.
// ---------------------------------------------------------------------------

let cache: Map<StyleKey, Record<string, PresetEntry>> | null = null;

/**
 * Seed the preset catalog from the boundary read. The payload is the
 * `get_strategy_presets` response: `{ presets: { economy: [...], standard: [...],
 * premium: [...] } }`, each entry `{ key, entry }`. Validates each entry against
 * `PresetEntrySchema` (fail-closed: a malformed entry throws).
 */
export function seedPresetCatalog(payload: unknown): void {
  const parsed = PresetCatalogPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`invalid preset catalog payload: ${parsed.error.message}`);
  }
  const loading = new Map<StyleKey, Record<string, PresetEntry>>();
  for (const style of ['economy', 'standard', 'premium'] as const) {
    const entries = parsed.data.presets[style] ?? [];
    const record: Record<string, PresetEntry> = {};
    for (const { key, entry } of entries) {
      record[key] = entry;
    }
    loading.set(style, record);
  }
  cache = loading;
}

/**
 * Reset the module-level preset cache (used by tests).
 */
export function resetPresetCache(): void {
  cache = null;
}

/**
 * Load the preset catalog. Returns the seeded cache; throws if it has not been
 * seeded (the API seeds it at startup before serving requests).
 */
export function loadPresets(): Map<StyleKey, Record<string, PresetEntry>> {
  if (!cache) {
    throw new Error('preset catalog not seeded — call seedPresetCatalog() at startup');
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

// The wire shape of the `get_strategy_presets` response (grouped by tier).
const PresetCatalogPayloadSchema = z.object({
  presets: z.record(
    z.enum(['economy', 'standard', 'premium']),
    z.array(z.object({ key: z.string(), entry: PresetEntrySchema })),
  ),
});
