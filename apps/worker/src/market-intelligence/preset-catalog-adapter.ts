import { listPresets } from '@herobids/domain/config/presets-loader';
import { isStyleKey, type PresetEntry, type StyleKey } from '@herobids/domain';

export type PresetCatalogEntry = { key: string; entry: PresetEntry };

const ALL_STYLE_TIERS: StyleKey[] = ['economy', 'standard', 'premium'];

/**
 * Create a preset catalog adapter for the PlatformAssessor.
 *
 * Eagerly loads all preset tiers at construction. Throws if any YAML file is
 * missing/malformed, or if any tier has zero presets. This ensures the worker
 * fails loudly at startup rather than silently using an empty catalog.
 *
 * Returns a `getPresets` callback matching `PlatformAssessorDeps.getPresets`.
 */
export function createPresetCatalog(): (styleTier: string) => PresetCatalogEntry[] {
  const catalog = new Map<StyleKey, PresetCatalogEntry[]>();

  for (const tier of ALL_STYLE_TIERS) {
    const raw = listPresets(tier); // throws on missing file / invalid YAML / schema error
    if (raw.length === 0) {
      throw new Error(
        `Preset catalog is empty for style tier "${tier}". ` +
        `Ensure config/strategy-presets/${tier}.yaml contains at least one preset.`,
      );
    }
    catalog.set(
      tier,
      raw.map(({ key, ...entryFields }) => ({
        key,
        entry: entryFields as PresetEntry,
      })),
    );
  }

  return (styleTier: string): PresetCatalogEntry[] => {
    if (!isStyleKey(styleTier)) {
      return [];
    }
    return catalog.get(styleTier) ?? [];
  };
}
