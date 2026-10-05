import {
  agentStyleToPresetStyle,
  applyPresetToAgent,
  isStyleKey,
  SWAP_VENUES,
  TechnicalConfigSchema,
  type CreatorStrategy,
  type ScanMode,
  type UnifiedAgentConfig,
} from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';

/**
 * Creator scan inputs herobids sends to traderton with every profile write
 * (004 ownership rule). `scanMode` drives the scan loop; `creatorStrategy` is
 * the creator-chosen strategy. herobids NEVER sends `activeStrategy` — traderton
 * derives it.
 */
export interface ProfileScanConfig {
  scanMode: ScanMode | null;
  creatorStrategy: CreatorStrategy | null;
}

/** Deterministic JSON with recursively sorted keys, for identity comparison. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
}

/** Read the loose `metadata` object off a unified config (not part of its Zod schema). */
function readMetadata(unifiedConfig: UnifiedAgentConfig | null): Record<string, unknown> | undefined {
  const metadata = (unifiedConfig as { metadata?: unknown } | null)?.metadata;
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined;
}

/**
 * Derive the scan config to send to traderton from the unified config THIS
 * operation will persist (the post-mutation state) and the agent's style.
 *
 * Rules (plan A2):
 *  1. Non-hybrid agent → no scan loop: `{ scanMode: null, creatorStrategy: null }`.
 *  2. `scanMode = hybridMode ?? 'mixed'`.
 *  3. No technical config → `creatorStrategy: null` (traderton rejects a
 *     scanner-gated profile without a strategy; the route surfaces it as 400).
 *  4. A preset identity is sent ONLY when the agent's technical config equals
 *     the preset's resolution AND the agent is not on a swap venue (traderton's
 *     preset branch emits no `filters.networks`, so a preset + scanner_gated on
 *     a swap venue cannot resolve a network). Otherwise `{ customTechnical }`,
 *     which preserves the connection-merged filters (incl. networks).
 *  5. `customTechnical` is normalised with `TechnicalConfigSchema.parse` so the
 *     stored value matches traderton's parsed form (defaults filled) and does
 *     not churn the revision on every resend.
 *  6. Never produce `activeStrategy`.
 */
export function deriveProfileScanConfig(input: {
  unifiedConfig: UnifiedAgentConfig | null;
  style: string | null;
}): ProfileScanConfig {
  const { unifiedConfig, style } = input;
  if (unifiedConfig?.capabilityMode !== 'hybrid') {
    return { scanMode: null, creatorStrategy: null };
  }

  const scanMode: ScanMode = unifiedConfig.hybridMode ?? 'mixed';

  const technical = unifiedConfig.technical;
  if (!technical) {
    return { scanMode, creatorStrategy: null };
  }

  const isSwap = technical.filters.venueType === 'swap'
    || (SWAP_VENUES as readonly string[]).includes(technical.filters.venue);

  const metadata = readMetadata(unifiedConfig);
  const presetKey = typeof metadata?.['strategyPreset'] === 'string' ? (metadata['strategyPreset'] as string) : undefined;
  const metaStyle = metadata?.['strategyPresetStyle'];
  const presetStyle = typeof metaStyle === 'string' && isStyleKey(metaStyle)
    ? metaStyle
    : agentStyleToPresetStyle(style ?? 'balanced');

  // Normalise the agent's technical config. An incomplete config (e.g. an
  // unbound agent whose venue/venueType is not yet resolved) cannot be parsed:
  // fail safe with a null creatorStrategy. traderton rejects a scanner-gated
  // profile without a strategy, which the route surfaces as a 400 — never a 500.
  const parsedTechnical = TechnicalConfigSchema.safeParse(technical);
  if (!parsedTechnical.success) {
    return { scanMode, creatorStrategy: null };
  }

  if (presetKey && !isSwap) {
    const presetTechnical = resolvePresetTechnical(presetKey, presetStyle);
    if (presetTechnical) {
      const fromPreset = TechnicalConfigSchema.safeParse({ ...presetTechnical, filters: technical.filters });
      if (fromPreset.success && canonicalJson(fromPreset.data) === canonicalJson(parsedTechnical.data)) {
        return { scanMode, creatorStrategy: { presetKey, styleTier: presetStyle } };
      }
    }
  }

  return { scanMode, creatorStrategy: { customTechnical: parsedTechnical.data } };
}

/**
 * Resolve a preset's technical section, or null when the preset is unknown or
 * cannot apply to an agent (e.g. `dca` throws). The null fall-through sends
 * `customTechnical` instead of a preset identity.
 */
function resolvePresetTechnical(
  presetKey: string,
  presetStyle: 'economy' | 'standard' | 'premium',
): Record<string, unknown> | null {
  try {
    const preset = getPreset(presetKey, presetStyle);
    if (!preset) return null;
    return applyPresetToAgent(presetKey, preset, presetStyle, 'llm').technical;
  } catch {
    return null;
  }
}
