import type { UnifiedAgentConfig } from '@herobids/domain';
import { deriveProfileScanConfig, type ProfileScanConfig } from './profile-scan-config.js';
import type { TradingProfileChanges } from './trading-profile-reconciliation.js';

export function deriveTradingProfileFields(input: {
  unifiedConfig: UnifiedAgentConfig | null;
  style: string | null;
  overrides?: TradingProfileChanges;
  preserveUnspecified?: boolean;
}): { changes: TradingProfileChanges; scanConfig: ProfileScanConfig } {
  const { unifiedConfig, overrides = {}, preserveUnspecified = false } = input;
  const config = unifiedConfig as (UnifiedAgentConfig & { capital?: string | null }) | null;
  const changes: TradingProfileChanges = {
    capital: overrides.capital !== undefined ? overrides.capital : config?.capital ?? null,
    riskPosture: overrides.riskPosture !== undefined ? overrides.riskPosture : config?.risk
      ? {
          maxOpenPositions: config.risk.maxPositions,
          maxPositionSizePct: config.risk.maxPositionSizePct,
          dailyMaxLossPct: config.risk.dailyMaxLossPct,
          stopLossPct: config.risk.stopLossPct,
        }
      : null,
    executionDefaults: overrides.executionDefaults !== undefined ? overrides.executionDefaults : config?.execution?.mode
      ? { mode: config.execution.mode }
      : null,
  };

  return {
    changes: preserveUnspecified
      ? Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as TradingProfileChanges
      : changes,
    scanConfig: deriveProfileScanConfig({ unifiedConfig, style: input.style }),
  };
}