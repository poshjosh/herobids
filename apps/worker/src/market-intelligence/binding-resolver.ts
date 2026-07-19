import type { Database } from '@herobids/db';
import { agentPresetBindings } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import { isStyleKey, type StyleKey } from '@herobids/domain';
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
      return specific;
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

  return defaultBinding ?? null;
}
