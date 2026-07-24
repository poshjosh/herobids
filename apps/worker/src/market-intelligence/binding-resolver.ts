import type { Database } from '@herobids/db';
import { agentPresetBindings } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import {
  isStyleKey,
  applyPresetToAgent,
  ok,
  err,
  type Result,
  type DomainError,
  type StyleKey,
  type AgentPresetMapping,
  type TechnicalConfig,
} from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';
import { IndicatorConfigSchema } from '@herobids/domain';
import { z } from 'zod';
import { createLogger } from '../logger.js';

const logger = createLogger('binding-resolver');

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The authoritative binding row from agent_preset_bindings.
 * Carries only identity/version fields — no derived fields like signalBias,
 * enabledIndicators, or compatibilityThresholds. Those are projected from the
 * preset catalog separately via applyPresetToAgent.
 */
export interface AuthoritativeBinding {
  /** The key of the active preset (e.g. momentum_v1). */
  activePresetKey: string;
  /** Style tier: economy | standard | premium. */
  styleTier: StyleKey;
  /** Mechanically derived behavior version. */
  behaviorVersion: string;
  /** The preset/config version applied. */
  appliedPresetVersion: string;
}

// ── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the authoritative preset binding for an agent from the
 * `agent_preset_bindings` table.
 *
 * Lookup order:
 * 1. If `scope` is provided, try that specific scope first
 * 2. Fall back to `scope = 'default'`
 * 3. If `scope` is not provided, query `scope = 'default'` directly
 *
 * Only rows with `status = 'active'` are considered.
 *
 * Returns `null` when no binding row exists — the caller should fall back to
 * unified-config derivation. Bindings are only created on transition, so a
 * fresh agent that has never transitioned has no binding row (the common case).
 */
export async function resolveAuthoritativeBinding(
  db: Database,
  agentId: string,
  scope?: string,
): Promise<AuthoritativeBinding | null> {
  const columns = {
    activePresetKey: agentPresetBindings.activePresetKey,
    styleTier: agentPresetBindings.styleTier,
    behaviorVersion: agentPresetBindings.behaviorVersion,
    appliedPresetVersion: agentPresetBindings.appliedPresetVersion,
  };

  // 1. Try specific scope if provided
  if (scope) {
    const [specific] = await db
      .select(columns)
      .from(agentPresetBindings)
      .where(
        and(
          eq(agentPresetBindings.agentId, agentId),
          eq(agentPresetBindings.scope, scope),
          eq(agentPresetBindings.status, 'active'),
        ),
      )
      .limit(1);

    if (specific) {
      if (!isStyleKey(specific.styleTier)) {
        logger.warn({ agentId, scope, styleTier: specific.styleTier }, 'Binding styleTier is not a valid StyleKey — ignoring binding');
        return null;
      }
      return specific as AuthoritativeBinding;
    }
  }

  // 2. Fall back to default scope (or use directly if no scope was provided)
  const [defaultBinding] = await db
    .select(columns)
    .from(agentPresetBindings)
    .where(
      and(
        eq(agentPresetBindings.agentId, agentId),
        eq(agentPresetBindings.scope, 'default'),
        eq(agentPresetBindings.status, 'active'),
      ),
    )
    .limit(1);

  if (defaultBinding && !isStyleKey(defaultBinding.styleTier)) {
    logger.warn({ agentId, styleTier: defaultBinding.styleTier }, 'Binding styleTier is not a valid StyleKey — ignoring binding');
    return null;
  }

  return (defaultBinding as AuthoritativeBinding | null) ?? null;
}

// ── Materialization ─────────────────────────────────────────────────────────

/**
 * Error codes returned by {@link materializeEffectiveConfig}.
 * Extends DomainError structurally (context is optional).
 */
export type MaterializeConfigError = {
  code: 'binding.preset_not_found' | 'binding.dca_unsupported';
  message: string;
  context?: Record<string, unknown>;
};

/**
 * Materialize the effective technical config from a resolved binding.
 *
 * This is the load-bearing piece of Item 10 — it projects the preset's
 * strategy parameters (indicators, candles, signal bias, scan interval) into
 * a shape suitable for `applyPendingConfigUpdate`.
 *
 * The caller is responsible for merging the returned fields with any
 * existing venue/filter configuration (the preset does not carry venue info).
 *
 * @returns The preset-derived technical config fields, or an error if the
 *          preset is not found or is a DCA (bot-only) preset.
 */
export function materializeEffectiveConfig(
  activePresetKey: string,
  styleTier: StyleKey,
): Result<AgentPresetMapping, MaterializeConfigError> {
  const preset = getPreset(activePresetKey, styleTier);
  if (!preset) {
    return err({
      code: 'binding.preset_not_found',
      message: `Preset "${activePresetKey}" not found in style tier "${styleTier}"`,
    });
  }

  try {
    const mapping = applyPresetToAgent(activePresetKey, preset, styleTier, 'llm');
    return ok(mapping);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return err({
      code: 'binding.dca_unsupported',
      message,
    });
  }
}

/**
 * Sub-schemas used to validate preset-mapping fields before they enter
 * the actor's technical config. Only the fields carried by the mapping
 * are checked — venue/filter fields are the caller's responsibility.
 */
const _candleIntervalSchema = z.enum(['5m', '15m', '1h', '4h', '1d']);
const _signalBiasSchema = z.enum(['trend-following', 'mean-reverting']);
const _scanIntervalMsSchema = z.number().int().min(10_000);

/**
 * Convert an {@link AgentPresetMapping} into a partial {@link TechnicalConfig}
 * suitable for merging with an actor's existing venue/filter config.
 *
 * Only preset-derived strategy fields are populated. The caller must merge
 * `filters`, `regime`, `autonomousExit`, `scanBatchSize` etc. from the
 * existing config.
 *
 * Each field is validated at the boundary before it enters the config —
 * malformed preset data is rejected rather than silently cast.
 */
export function mappingToTechnicalConfig(
  mapping: AgentPresetMapping,
): Result<
  Pick<TechnicalConfig, 'indicators' | 'candles' | 'signalBias' | 'scanIntervalMs'> & Partial<Pick<TechnicalConfig, 'scanBatchSize'>>,
  DomainError
> {
  // Validate indicator config
  const indicatorsResult = IndicatorConfigSchema.safeParse(mapping.technical.indicators);
  if (!indicatorsResult.success) {
    return err({
      code: 'binding.invalid_indicators',
      message: `Preset indicator config failed validation: ${indicatorsResult.error.message}`,
    });
  }

  // Validate candle interval
  const intervalResult = _candleIntervalSchema.safeParse(mapping.technical.candles.interval);
  if (!intervalResult.success) {
    return err({
      code: 'binding.invalid_candle_interval',
      message: `Preset candle interval "${mapping.technical.candles.interval}" is not a valid interval`,
    });
  }

  // Validate candle limit (number, integer, in range)
  const limit = mapping.technical.candles.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 20 || limit > 500) {
    return err({
      code: 'binding.invalid_candle_limit',
      message: `Preset candle limit ${limit} is not a valid integer in [20, 500]`,
    });
  }

  // Validate signal bias
  const biasResult = _signalBiasSchema.safeParse(mapping.technical.signalBias);
  if (!biasResult.success) {
    return err({
      code: 'binding.invalid_signal_bias',
      message: `Preset signal bias "${mapping.technical.signalBias}" is not valid`,
    });
  }

  // Validate scan interval (falls back to 60_000 if absent)
  const rawScanInterval = mapping.technical.scanIntervalMs ?? 60_000;
  const scanResult = _scanIntervalMsSchema.safeParse(rawScanInterval);
  if (!scanResult.success) {
    return err({
      code: 'binding.invalid_scan_interval',
      message: `Preset scan interval ${rawScanInterval} must be an integer ≥ 10000`,
    });
  }

  return ok({
    indicators: indicatorsResult.data,
    candles: {
      interval: intervalResult.data,
      limit,
    },
    signalBias: biasResult.data,
    scanIntervalMs: scanResult.data,
  });
}
