import { agentStyleToPresetStyle, applyPresetToAgent } from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';

/**
 * Resolve a style-based strategy preset into agent config fields.
 *
 * Returns the unifiedConfig patch and risk column overrides to persist.
 * Explicit user-supplied risk values take precedence over preset defaults.
 */
export function resolveAgentStrategyPreset(params: {
  strategyPreset: string;
  style: string | null | undefined;
  explicitStopLossPct?: number | null;
  explicitMaxPositionSizePct?: number | null;
}): {
  unifiedConfigPatch: Record<string, unknown>;
  riskOverrides: { stopLossPct?: string | null; maxPositionSizePct?: string | null };
} | null {
  const { strategyPreset, style, explicitStopLossPct, explicitMaxPositionSizePct } = params;

  const presetStyle = agentStyleToPresetStyle(style ?? 'balanced');
  const preset = getPreset(strategyPreset, presetStyle);
  if (!preset) {
    return null;
  }

  const split = applyPresetToAgent(strategyPreset, preset, presetStyle, 'llm');

  // Build unifiedConfig with technical, execution, and metadata
  const unifiedConfigPatch: Record<string, unknown> = {
    technical: split.technical,
    execution: {
      mode: undefined,
      positionSizeMode: (split.execution.positionSizeMode as 'fixed' | 'percent_equity' | undefined) ?? undefined,
      fixedPositionSize: split.execution.fixedPositionSize,
    },
    metadata: {
      strategyPreset,
      strategyPresetName: preset.name,
      strategyPresetStyle: presetStyle,
      strategyPresetSource: 'agent-style',
      presetBehaviorVersion: split.presetBehaviorVersion,
    },
  };

  // Remove undefined keys from execution to keep config clean
  const exec = unifiedConfigPatch['execution'] as Record<string, unknown>;
  if (exec['positionSizeMode'] === undefined && exec['fixedPositionSize'] === undefined) {
    delete unifiedConfigPatch['execution'];
  } else {
    // Clean individual undefined values
    for (const key of Object.keys(exec)) {
      if (exec[key] === undefined) delete exec[key];
    }
  }

  // Risk overrides: explicit user values win, otherwise use preset defaults
  const stopLossPct =
    explicitStopLossPct !== undefined
      ? (explicitStopLossPct != null ? String(explicitStopLossPct) : null)
      : (split.risk.stopLossPct != null ? String(split.risk.stopLossPct) : undefined);

  const maxPositionSizePct =
    explicitMaxPositionSizePct !== undefined
      ? (explicitMaxPositionSizePct != null ? String(explicitMaxPositionSizePct) : null)
      : (split.risk.maxPositionSizePct != null ? String(split.risk.maxPositionSizePct) : undefined);

  return {
    unifiedConfigPatch,
    riskOverrides: { stopLossPct, maxPositionSizePct },
  };
}
