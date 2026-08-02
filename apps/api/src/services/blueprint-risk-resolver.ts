import type { RiskPosture, EffectiveRiskProfile, EffectiveRiskField } from '@herobids/domain';
import type { AgentRiskDefaultsConfig } from '@herobids/domain';

/**
 * Resolve the effective risk profile for an agent blueprint instantiation.
 *
 * Rules (per the Phase 1 plan):
 *
 * For each of the 9 RiskPosture fields:
 * - If installer explicitly set a number → source: 'user', mutable: false
 * - If installer explicitly set null → source: 'default', mutable: true (where
 *   the field's risk contract permits mutability)
 * - If field omitted → inherit the exact raw revision member (including
 *   null/omitted)
 * - For null/omitted → use operator default, mutable: true
 * - dailyMaxLossPct, maxNewPositionsPerDay, avoidParabolicMovePct,
 *   maxOrderNotional → never mutable
 *
 * @param rawRisk - The nullable RiskPosture from the blueprint revision payload
 * @param installerEdits - Partial risk overrides from the installer's edit payload
 * @param operatorDefaults - Operator-configured risk defaults
 */
export function resolveEffectiveRisk(
  rawRisk: RiskPosture | null,
  installerEdits: Partial<RiskPosture> | null,
  operatorDefaults: AgentRiskDefaultsConfig,
): EffectiveRiskProfile {
  const fields: Array<{
    key: keyof EffectiveRiskProfile;
    rawField: number | null | undefined;
    editValue: number | null | undefined;
    operatorDefault: number;
    mutable: boolean;
  }> = [
    {
      key: 'maxOpenPositions',
      rawField: rawRisk?.maxOpenPositions ?? undefined,
      editValue: installerEdits?.maxOpenPositions,
      operatorDefault: operatorDefaults.maxOpenPositions,
      mutable: true,
    },
    {
      key: 'maxPositionSizePct',
      rawField: rawRisk?.maxPositionSizePct ?? undefined,
      editValue: installerEdits?.maxPositionSizePct,
      operatorDefault: operatorDefaults.maxPositionSizePct,
      mutable: true,
    },
    {
      key: 'stopLossPct',
      rawField: rawRisk?.stopLossPct ?? undefined,
      editValue: installerEdits?.stopLossPct,
      operatorDefault: operatorDefaults.stopLossPct,
      mutable: true,
    },
    {
      key: 'stopLossCooldownMs',
      rawField: rawRisk?.stopLossCooldownMs ?? undefined,
      editValue: installerEdits?.stopLossCooldownMs,
      operatorDefault: operatorDefaults.stopLossCooldownMs,
      mutable: true,
    },
    {
      key: 'maxDrawdownPct',
      rawField: rawRisk?.maxDrawdownPct ?? undefined,
      editValue: installerEdits?.maxDrawdownPct,
      operatorDefault: operatorDefaults.maxDrawdownPct,
      mutable: true,
    },
    {
      key: 'dailyMaxLossPct',
      rawField: rawRisk?.dailyMaxLossPct ?? undefined,
      editValue: installerEdits?.dailyMaxLossPct,
      operatorDefault: operatorDefaults.dailyMaxLossPct,
      mutable: false, // never agent-mutable
    },
    {
      key: 'maxNewPositionsPerDay',
      rawField: rawRisk?.maxNewPositionsPerDay ?? undefined,
      editValue: installerEdits?.maxNewPositionsPerDay,
      operatorDefault: 0, // disabled by default
      mutable: false, // never agent-mutable
    },
    {
      key: 'avoidParabolicMovePct',
      rawField: rawRisk?.avoidParabolicMovePct ?? undefined,
      editValue: installerEdits?.avoidParabolicMovePct,
      operatorDefault: 0, // disabled by default
      mutable: false, // never agent-mutable
    },
    {
      key: 'maxOrderNotional',
      rawField: rawRisk?.maxOrderNotional ?? undefined,
      editValue: installerEdits?.maxOrderNotional,
      operatorDefault: operatorDefaults.maxPositionSize * operatorDefaults.maxOrderNotionalMultiplier,
      mutable: false, // never agent-mutable
    },
  ];

  const result = {} as Record<string, EffectiveRiskField>;

  for (const { key, rawField, editValue, operatorDefault, mutable } of fields) {
    if (editValue !== undefined) {
      if (editValue === null) {
        // Installer explicitly null → use operator default, mutable (if contract permits)
        result[key] = {
          rawValue: null,
          effectiveValue: operatorDefault,
          source: 'default',
          mutable: mutable,
          operatorCeiling: operatorDefault,
          enforced: true,
        };
      } else {
        // Installer explicitly set a number — clamp at operator ceiling
        const cappedValue = Math.min(editValue, operatorDefault);
        result[key] = {
          rawValue: editValue,
          effectiveValue: cappedValue,
          source: 'user',
          mutable: false,
          operatorCeiling: operatorDefault,
          enforced: cappedValue !== editValue,
        };
      }
    } else {
      // Field omitted by installer → inherit the raw revision member
      if (rawField != null) {
        result[key] = {
          rawValue: rawField,
          effectiveValue: rawField,
          source: 'user',
          mutable: false,
          operatorCeiling: operatorDefault,
          enforced: true,
        };
      } else if (rawField === null) {
        // Raw revision explicitly null → operator default, mutable
        result[key] = {
          rawValue: null,
          effectiveValue: operatorDefault,
          source: 'default',
          mutable: mutable,
          operatorCeiling: operatorDefault,
          enforced: true,
        };
      } else {
        // Absent from both → operator default, mutable
        result[key] = {
          rawValue: null,
          effectiveValue: key === 'maxNewPositionsPerDay' || key === 'avoidParabolicMovePct'
            ? null // disabled for these
            : operatorDefault,
          source: 'disabled',
          mutable: false,
          operatorCeiling: operatorDefault,
          enforced: false,
        };
      }
    }
  }

  return result as unknown as EffectiveRiskProfile;
}
