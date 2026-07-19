import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  ChangeStrategyPresetParamsSchema,
  isArtifactFresh,
} from '@herobids/domain';
import type { PresetTransitionPort } from '@herobids/domain';
import { marketAssessmentArtifacts } from '@herobids/db';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('tool:change-strategy-preset');

type Db = PostgresJsDatabase<typeof schema>;

// ── Module-level port reference ────────────────────────────────────────────

let transitionPort: PresetTransitionPort | null = null;

export function setPresetTransitionPort(p: PresetTransitionPort): void {
  transitionPort = p;
}

async function executeApplyPresetTransition(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ChangeStrategyPresetParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { assessmentArtifactId, targetPreset, mode, reason } = parsed.data;

  // ── Gate: Ensure platform assessment is enabled for this agent ─────
  if (ctx.agentConfigOps) {
    const currentConfig = await ctx.agentConfigOps.getCurrentConfig();
    const assessmentEnabled = currentConfig?.platformAssessment?.enabled;
    if (!assessmentEnabled) {
      logger.warn({ agentId: ctx.agentId }, 'Blocked preset transition — platformAssessment is not enabled');
      return {
        success: false,
        error: 'Platform assessment is not enabled for this agent — cannot apply preset transitions',
        errorCode: 'assessment.not_enabled',
      };
    }
  }

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    // ── Gate 1: Fetch and validate the exact assessment artifact ─────────
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

    // ── Gate 2: Validate target preset is in the allowed set ─────────────
    const allowedPresets = artifactRow.allowedPresets as string[] ?? [];
    if (allowedPresets.length > 0 && !allowedPresets.includes(targetPreset)) {
      return {
        success: false,
        error: `Preset "${targetPreset}" is not in the allowed presets for this assessment. Allowed: ${allowedPresets.join(', ')}`,
        errorCode: 'transition.preset_not_allowed',
      };
    }

    // ── Gate 3: Validate artifact freshness ──────────────────────────────
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

    // ── Delegate to PresetTransitionPort ────────────────────────────────

    if (!transitionPort) {
      return {
        success: false,
        error: 'Preset transition port not wired — transitions are not available.',
        errorCode: 'transition.port_unavailable',
      };
    }

    const transitionResult = await transitionPort.applyTransition({
      agentId: ctx.agentId,
      assessmentArtifactId,
      targetPreset,
      mode,
      reason: reason ?? 'Agent-initiated preset transition',
      idempotencyKey: randomUUID(),
    });

    if (!transitionResult.ok) {
      logger.error(
        { err: transitionResult.error, agentId: ctx.agentId, targetPreset, mode },
        'Preset transition failed via port',
      );
      return {
        success: false,
        error: transitionResult.error.message,
        errorCode: transitionResult.error.code,
      };
    }

    const applied = transitionResult.data;

    // ── Journal for audit ────────────────────────────────────────────────
    if (ctx.agentConfigOps) {
      await ctx.agentConfigOps.appendJournal('preset_transition', {
        targetPreset,
        mode,
        reason: reason ?? 'Agent-initiated preset transition',
        assessmentArtifactId,
        transitionId: applied.transitionId,
        state: applied.state,
        appliedAt: applied.appliedAt,
      });
    }

    // TODO(analytics): record transition metrics for later attribution analysis.
    // Capture: agentId, targetPreset, assessmentArtifactId,
    // transitionMode, transitionId, state, appliedAt. Feed into analytics pipeline
    // once attribution quality is validated (see checklist §13).

    logger.info(
      { agentId: ctx.agentId, targetPreset, mode, transitionId: applied.transitionId, state: applied.state },
      'Preset transition applied via port',
    );

    return {
      success: true,
      data: {
        applied: applied.state === 'applied',
        targetPreset,
        mode,
        assessmentArtifactId,
        transitionId: applied.transitionId,
        state: applied.state,
        message: `Preset transition ${applied.state}: switched to "${targetPreset}" in "${mode}" mode. Future entries will use the new preset configuration.`,
        appliedAt: applied.appliedAt,
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
  parametersSchema: ChangeStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(ChangeStrategyPresetParamsSchema),
  category: 'write-database',
  execute: executeApplyPresetTransition,
};
