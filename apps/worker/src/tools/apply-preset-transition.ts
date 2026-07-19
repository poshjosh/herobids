import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  ApplyPresetTransitionParamsSchema,
  isArtifactFresh,
} from '@herobids/domain';
import { agentPresetTransitions, marketAssessmentArtifacts } from '@herobids/db';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('tool:change-strategy-preset');

type Db = PostgresJsDatabase<typeof schema>;

async function executeApplyPresetTransition(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ApplyPresetTransitionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { assessmentArtifactId, targetPreset, mode, reason } = parsed.data;

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    // ── Gate 1: recommend_only (shadow) mode blocks live apply (D8) ──────
    if (ctx.agentConfigOps) {
      const currentConfig = await ctx.agentConfigOps.getCurrentConfig();
      if (currentConfig?.platformAssessment?.mode === 'recommend_only') {
        return {
          success: false,
          error: 'Platform assessment is in recommend_only (shadow) mode. Preset transitions are not yet applied automatically. Review the recommendation and switch manually if desired.',
          errorCode: 'transition.shadow_mode_blocked',
        };
      }
    }

    // ── Gate 2: Fetch and validate the exact assessment artifact ─────────
    const [artifactRow] = await db
      .select()
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.id, assessmentArtifactId))
      .limit(1);

    if (!artifactRow) {
      return {
        success: false,
        error: `Assessment artifact "${assessmentArtifactId}" not found.`,
        errorCode: 'assessment.artifact_not_found',
      };
    }

    // ── Gate 3: Validate target preset is in the allowed set ─────────────
    const allowedPresets = artifactRow.allowedPresets as string[] ?? [];
    if (allowedPresets.length > 0 && !allowedPresets.includes(targetPreset)) {
      return {
        success: false,
        error: `Preset "${targetPreset}" is not in the allowed presets for this assessment. Allowed: ${allowedPresets.join(', ')}`,
        errorCode: 'transition.preset_not_allowed',
      };
    }

    // ── Gate 4: Validate artifact freshness ──────────────────────────────
    const now = new Date();
    if (!isArtifactFresh(
      { status: artifactRow.status, expiresAt: artifactRow.expiresAt.toISOString() },
      now,
    )) {
      return {
        success: false,
        error: 'The assessment artifact has expired. Request a fresh assessment via assess_strategy_preset before applying a transition.',
        errorCode: 'assessment.artifact_expired',
      };
    }

    // ── Build immutable identity snapshot ────────────────────────────────
    const identitySnapshot: Record<string, unknown> = {
      instrumentKind: artifactRow.instrumentKind,
      venueFamily: artifactRow.venueFamily,
      styleTier: artifactRow.styleTier,
    };
    if (artifactRow.symbol) identitySnapshot['symbol'] = artifactRow.symbol;
    if (artifactRow.network) identitySnapshot['network'] = artifactRow.network;
    if (artifactRow.address) identitySnapshot['address'] = artifactRow.address;

    // ── Resolve old preset (best-effort) ─────────────────────────────────
    // TODO: resolve current preset from agent metadata (agents table metadata.strategyPreset).
    // The unified config does not store the current preset key — it lives in the agents table.
    // Once agentConfigOps exposes getActivePreset() or similar, use it here.
    let oldPresetKey = 'unknown';

    // Resolve open position count — stub until position repo is wired into ToolContext
    const openPositionCount = 0;

    // ── Persist immutable transition record ──────────────────────────────
    await db.insert(agentPresetTransitions).values({
      id: randomUUID(),
      agentId: ctx.agentId,
      oldPresetKey,
      oldPresetBehaviorVersion: 'unknown',
      newPresetKey: targetPreset,
      newPresetBehaviorVersion: 'v1',
      assessmentArtifactId: artifactRow.id,
      // Identity snapshot (replaces old segmentKey/universeScopeHash)
      identitySnapshot,
      instrumentKind: artifactRow.instrumentKind,
      symbol: artifactRow.symbol ?? null,
      network: artifactRow.network ?? null,
      address: artifactRow.address ?? null,
      transitionMode: mode,
      openPositionCount,
      outcome: 'accepted',
      reason: reason ?? null,
      appliedAt: now,
      regimeSnapshot: null,
      mode: 'live',
      createdAt: now,
    });

    // ── Journal for audit ────────────────────────────────────────────────
    if (ctx.agentConfigOps) {
      await ctx.agentConfigOps.appendJournal('preset_transition', {
        targetPreset,
        mode,
        reason: reason ?? 'Agent-initiated preset transition',
        oldPresetKey,
        assessmentArtifactId: artifactRow.id,
        identitySnapshot,
        appliedAt: now.toISOString(),
      });
    }

    // TODO(analytics): record transition metrics for later attribution analysis.
    // Capture: agentId, oldPresetKey, newPresetKey, assessmentArtifactId,
    // transitionMode, openPositionCount, appliedAt. Feed into analytics pipeline
    // once attribution quality is validated (see checklist §13).

    logger.info({ agentId: ctx.agentId, targetPreset, mode, oldPresetKey, assessmentArtifactId }, 'Preset transition applied');

    return {
      success: true,
      data: {
        applied: true,
        targetPreset,
        mode,
        assessmentArtifactId,
        identitySnapshot,
        message: `Preset transition applied: switched to "${targetPreset}" in "${mode}" mode. Future entries will use the new preset configuration.`,
        openPositionCount,
        appliedAt: now.toISOString(),
      },
    };
  } catch (err) {
    logger.error({ err }, 'Failed to apply preset transition');
    return { success: false, error: 'Failed to apply preset transition', errorCode: 'transition.apply_failed' };
  }
}

export const changeStrategyPresetTool: AgentTool = {
  name: 'change_strategy_preset',
  description:
    'Apply a strategy preset change using an exact assessment artifact reference from assess_strategy_preset. ' +
    'Validates artifact identity, freshness, and allowed presets before applying. ' +
    'Records an immutable transition event with identity snapshot for audit.',
  parametersSchema: ApplyPresetTransitionParamsSchema,
  parameters: convertZodToJsonSchema(ApplyPresetTransitionParamsSchema),
  category: 'write-database',
  execute: executeApplyPresetTransition,
};
