import { ok, type Result, type ActivePresetState, isStyleKey, applyPresetToAgent, type StyleKey, type StrategyIdentity } from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';
import type { Database } from '@herobids/db';
import { resolveAuthoritativeBinding } from './binding-resolver.js';
import { createLogger } from '../logger.js';

const logger = createLogger('resolve-active-preset');

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the agent's active preset state via a single shared path.
 *
 * Resolution order:
 * 1. Authoritative binding (agent_preset_bindings row) → getPreset + applyPresetToAgent
 * 2. Unified-config metadata fallback (metadata.strategyPreset + metadata.strategyPresetStyle)
 * 3. Last-resort safety fallback (presetKey: 'momentum' with a loud warn log)
 */
export async function resolveActivePresetState(
  db: Database,
  agent: { id: string; unifiedConfig: unknown; strategy?: StrategyIdentity | null },
): Promise<Result<ActivePresetState>> {
  // ── Step 1: Authoritative binding ─────────────────────────────────────
  const binding = await resolveAuthoritativeBinding(db, agent.id);
  if (binding) {
    const preset = getPreset(binding.activePresetKey, binding.styleTier);
    if (preset) {
      try {
        const mapping = applyPresetToAgent(binding.activePresetKey, preset, binding.styleTier, 'llm');
        return ok({
          presetKey: mapping.presetKey,
          behaviorVersion: mapping.presetBehaviorVersion,
          styleTier: binding.styleTier,
          scanInterval: mapping.technical.scanIntervalMs != null
            ? String(mapping.technical.scanIntervalMs)
            : undefined,
          signalBias: (mapping.technical.signalBias as 'bullish' | 'bearish' | 'neutral') ?? 'neutral',
          enabledIndicators: Object.keys(mapping.technical.indicators),
          compatibilityThresholds: {},
        });
      } catch (err) {
        logger.warn({ agentId: agent.id, binding, err }, 'applyPresetToAgent failed (e.g. DCA preset) — falling back to unified config');
      }
    } else {
      logger.warn({ agentId: agent.id, binding }, 'Binding references unknown preset key — falling back to unified config');
    }
  }

  // ── Step 2: Canonical strategy + unifiedConfig metadata fallback ──────
  const uc = (agent.unifiedConfig ?? {}) as Record<string, unknown>;
  const metadata = (uc['metadata'] ?? {}) as Record<string, unknown>;
  // Prefer canonical strategy.type; fall back to unifiedConfig.metadata.strategyPreset
  const canonicalPreset = agent.strategy?.type ?? null;
  const strategyPreset = canonicalPreset
    ?? (metadata['strategyPreset'] as string | undefined);
  const strategyPresetStyle = metadata['strategyPresetStyle'] as string | undefined;
  const presetBehaviorVersion = metadata['presetBehaviorVersion'] as string | undefined;
  const allowedPresets = (uc['allowedPresets'] ?? {}) as Record<string, unknown>;

  if (typeof strategyPreset === 'string' && strategyPreset.length > 0) {
    const styleTier: StyleKey = (typeof strategyPresetStyle === 'string' && isStyleKey(strategyPresetStyle))
      ? strategyPresetStyle
      : (typeof allowedPresets['styleTier'] === 'string' && isStyleKey(allowedPresets['styleTier'] as string))
        ? (allowedPresets['styleTier'] as StyleKey)
        : 'standard';

    const preset = getPreset(strategyPreset, styleTier);
    if (preset) {
      try {
        const mapping = applyPresetToAgent(strategyPreset, preset, styleTier, 'llm');
        return ok({
          presetKey: mapping.presetKey,
          behaviorVersion: presetBehaviorVersion ?? mapping.presetBehaviorVersion,
          styleTier,
          scanInterval: mapping.technical.scanIntervalMs != null
            ? String(mapping.technical.scanIntervalMs)
            : undefined,
          signalBias: (mapping.technical.signalBias as 'bullish' | 'bearish' | 'neutral') ?? 'neutral',
          enabledIndicators: Object.keys(mapping.technical.indicators),
          compatibilityThresholds: {},
        });
      } catch (err) {
        logger.warn({ agentId: agent.id, strategyPreset, styleTier, err }, 'applyPresetToAgent failed for metadata preset — falling back to safety default');
      }
    } else {
      logger.warn({ agentId: agent.id, strategyPreset, styleTier }, 'Metadata preset key not found in catalog — falling back to safety default');
    }
  }

  // ── Step 3: Last-resort safety fallback ───────────────────────────────
  const allowedStyleTier = allowedPresets['styleTier'] as string | undefined;
  const fallbackStyleTier: StyleKey = (typeof allowedStyleTier === 'string' && isStyleKey(allowedStyleTier)) ? allowedStyleTier : 'standard';
  logger.warn({ agentId: agent.id, fallbackStyleTier }, 'No active preset resolved — using safety fallback "momentum"');

  return ok({
    presetKey: 'momentum',
    behaviorVersion: `uc-${fallbackStyleTier}-momentum-fallback`,
    styleTier: fallbackStyleTier,
    scanInterval: undefined,
    signalBias: 'neutral',
    enabledIndicators: [],
    compatibilityThresholds: {},
  });
}
