// Boundary-sourced preset catalog seeder (D2-a Option 1).
//
// Traderton is the sole authority for the strategy preset definitions. Herobids
// fetches the full catalog over the `get_strategy_presets` read tool at API
// startup and seeds the domain `presets-loader` module cache, so the existing
// synchronous `getPreset` / `listPresets` call sites (create/blueprint flows)
// keep working unchanged. Fail-closed: a failed fetch or malformed payload
// throws at startup rather than serving a partial catalog.

import { seedPresetCatalog } from '@herobids/domain/config/presets-loader';
import type { TradertonReadBoundary } from './routes/exports-traderton.js';

/**
 * Fetch the full preset catalog over the boundary and seed the domain cache.
 * Throws on a non-success boundary result or a malformed payload.
 */
export async function seedPresetsFromBoundary(boundary: TradertonReadBoundary): Promise<void> {
  const result = await boundary.invoke({ toolName: 'get_strategy_presets', payload: {} });
  if (result.kind !== 'success') {
    throw new Error(
      `failed to fetch preset catalog from traderton: ${result.kind === 'failure' ? result.code : result.kind}`,
    );
  }
  seedPresetCatalog(result.data);
}