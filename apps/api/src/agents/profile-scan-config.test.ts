import { describe, expect, it } from 'vitest';
import {
  applyPresetToAgent,
  TechnicalConfigSchema,
  type UnifiedAgentConfig,
} from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';
import { deriveProfileScanConfig } from './profile-scan-config.js';

const ORDERBOOK_FILTERS = { venue: 'hyperliquid', venueType: 'orderbook' as const };

/** Build an agent technical config that EXACTLY matches a resolved preset. */
function presetMatchedTechnical(presetKey: string, style: 'economy' | 'standard' | 'premium') {
  const preset = getPreset(presetKey, style)!;
  const technical = applyPresetToAgent(presetKey, preset, style, 'llm').technical;
  return TechnicalConfigSchema.parse({ ...technical, filters: ORDERBOOK_FILTERS });
}

function hybridConfig(overrides: Partial<UnifiedAgentConfig> & { metadata?: unknown } = {}): UnifiedAgentConfig {
  return {
    capabilityMode: 'hybrid',
    hybridMode: 'scanner_gated',
    technical: TechnicalConfigSchema.parse({ filters: ORDERBOOK_FILTERS }),
    authorizationMode: 'direct',
    ...overrides,
  } as UnifiedAgentConfig;
}

describe('deriveProfileScanConfig', () => {
  it('returns null scan config for an intelligence agent', () => {
    const result = deriveProfileScanConfig({
      unifiedConfig: { capabilityMode: 'intelligence', authorizationMode: 'direct' } as UnifiedAgentConfig,
      style: 'balanced',
    });
    expect(result).toEqual({ scanMode: null, creatorStrategy: null });
  });

  it('returns null scan config when there is no unified config', () => {
    expect(deriveProfileScanConfig({ unifiedConfig: null, style: null }))
      .toEqual({ scanMode: null, creatorStrategy: null });
  });

  it('uses hybridMode as scanMode and defaults to mixed', () => {
    const scanner = deriveProfileScanConfig({ unifiedConfig: hybridConfig({ hybridMode: 'scanner_gated' }), style: 'balanced' });
    expect(scanner.scanMode).toBe('scanner_gated');

    const withoutMode = hybridConfig();
    delete (withoutMode as { hybridMode?: unknown }).hybridMode;
    expect(deriveProfileScanConfig({ unifiedConfig: withoutMode, style: 'balanced' }).scanMode).toBe('mixed');
  });

  it('returns a null creatorStrategy when a hybrid agent has no technical config', () => {
    const config = hybridConfig();
    delete (config as { technical?: unknown }).technical;
    expect(deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' }))
      .toEqual({ scanMode: 'scanner_gated', creatorStrategy: null });
  });

  it('returns a null creatorStrategy without throwing when an unbound agent technical has no filters', () => {
    // An unbound hybrid agent: the preset fills technical, but filters are only
    // populated from a connection, so there are none yet.
    const preset = getPreset('momentum', 'standard')!;
    const unboundTechnical = applyPresetToAgent('momentum', preset, 'standard', 'llm').technical;
    const config = hybridConfig({
      hybridMode: 'mixed',
      technical: unboundTechnical as unknown as UnifiedAgentConfig['technical'],
    });
    expect(deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' }))
      .toEqual({ scanMode: 'mixed', creatorStrategy: null });
  });

  it('sends presetKey and styleTier when technical equals the preset resolution', () => {
    const config = hybridConfig({
      technical: presetMatchedTechnical('momentum', 'standard'),
      metadata: { strategyPreset: 'momentum', strategyPresetStyle: 'standard' },
    });
    const result = deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' });
    expect(result.creatorStrategy).toEqual({ presetKey: 'momentum', styleTier: 'standard' });
  });

  it('sends customTechnical when technical overrides a selected preset', () => {
    const technical = presetMatchedTechnical('momentum', 'standard');
    // Diverge from the preset resolution so the identity no longer matches.
    technical.scanIntervalMs = technical.scanIntervalMs + 30_000;
    const config = hybridConfig({
      technical,
      metadata: { strategyPreset: 'momentum', strategyPresetStyle: 'standard' },
    });
    const result = deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' });
    expect(result.creatorStrategy).toHaveProperty('customTechnical');
  });

  it('sends customTechnical for a preset agent on a swap venue', () => {
    const technical = TechnicalConfigSchema.parse({
      filters: { venue: 'jupiter', venueType: 'swap', networks: ['solana'] },
    });
    const config = hybridConfig({
      technical,
      metadata: { strategyPreset: 'momentum', strategyPresetStyle: 'standard' },
    });
    const result = deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' });
    expect(result.creatorStrategy).toHaveProperty('customTechnical');
  });

  it('sends customTechnical normalised with schema defaults', () => {
    // A technical config missing optional fields: the sent customTechnical is
    // the schema-parsed form with defaults filled, not the raw input.
    const raw = { filters: ORDERBOOK_FILTERS } as unknown as UnifiedAgentConfig['technical'];
    const config = hybridConfig({ technical: raw });
    const result = deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' });
    expect(result.creatorStrategy).toEqual({ customTechnical: TechnicalConfigSchema.parse({ filters: ORDERBOOK_FILTERS }) });
  });

  it('never returns an activeStrategy key', () => {
    const config = hybridConfig({
      technical: presetMatchedTechnical('momentum', 'standard'),
      metadata: { strategyPreset: 'momentum', strategyPresetStyle: 'standard' },
    });
    const result = deriveProfileScanConfig({ unifiedConfig: config, style: 'balanced' });
    expect(JSON.stringify(result)).not.toContain('activeStrategy');
    expect(JSON.stringify(result)).not.toContain('active_strategy');
  });
});
