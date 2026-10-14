import { describe, expect, it } from 'vitest';
import { TechnicalConfigSchema, type UnifiedAgentConfig } from '@herobids/domain';
import { deriveTradingProfileFields } from './trading-profile-fields.js';

describe('deriveTradingProfileFields', () => {
  const unifiedConfig = {
    capabilityMode: 'intelligence',
    authorizationMode: 'direct',
    capital: '100',
    risk: { maxPositions: 3, dailyMaxLossPct: 5 },
    execution: { mode: 'paper' },
  } as UnifiedAgentConfig & { capital: string };

  it('prefers explicit fields over config values and config values over null', () => {
    expect(deriveTradingProfileFields({ unifiedConfig, style: null, overrides: {
      capital: '200', executionDefaults: { mode: 'live' },
    } })).toEqual({
      changes: {
        capital: '200',
        riskPosture: { maxOpenPositions: 3, maxPositionSizePct: undefined, dailyMaxLossPct: 5, stopLossPct: undefined },
        executionDefaults: { mode: 'live' },
      },
      scanConfig: { scanMode: null, creatorStrategy: null, presetPolicy: null },
    });
    expect(deriveTradingProfileFields({ unifiedConfig: null, style: null }).changes)
      .toEqual({ capital: null, riskPosture: null, executionDefaults: null });
    expect(deriveTradingProfileFields({ unifiedConfig, style: null, overrides: { capital: null } }).changes.capital)
      .toBeNull();
  });

  it('preserves unspecified profile fields for updates and passes through scan config', () => {
    const hybridConfig: UnifiedAgentConfig = {
      capabilityMode: 'hybrid',
      hybridMode: 'scanner_gated',
      authorizationMode: 'direct',
      technical: TechnicalConfigSchema.parse({ filters: { venue: 'hyperliquid', venueType: 'orderbook' } }),
    };
    const result = deriveTradingProfileFields({ unifiedConfig: hybridConfig, style: null, preserveUnspecified: true, overrides: { capital: null } });
    expect(result.changes).toEqual({ capital: null });
    expect(result.scanConfig).toEqual({
      scanMode: 'scanner_gated',
      creatorStrategy: { customTechnical: hybridConfig.technical },
      presetPolicy: null,
    });
  });
});