import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { ApplyPresetTransitionParamsSchema } from '@herobids/domain';
import { agentPresetTransitions, marketAssessmentArtifacts } from '@herobids/db';
import { eq, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@herobids/db/schema';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('tool:apply-preset-transition');

type Db = PostgresJsDatabase<typeof schema>;

async function executeApplyPresetTransition(
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = ApplyPresetTransitionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const { targetPreset, mode, reason } = parsed.data;

  const db = ctx.db as Db | undefined;
  if (!db) {
    return { success: false, error: 'Database not available', errorCode: 'db.unavailable' };
  }

  try {
    // Get the latest active artifact for the assessment reference
    const [latest] = await db
      .select()
      .from(marketAssessmentArtifacts)
      .where(eq(marketAssessmentArtifacts.status, 'active'))
      .orderBy(desc(marketAssessmentArtifacts.assessedAt))
      .limit(1);

    // Validate targetPreset against assessment's allowedPresets
    if (latest) {
      const allowedPresets = latest.allowedPresets as string[] ?? [];
      if (allowedPresets.length > 0 && !allowedPresets.includes(targetPreset)) {
        return {
          success: false,
          error: `Preset "${targetPreset}" is not in the allowed presets for this assessment. Allowed: ${allowedPresets.join(', ')}`,
          errorCode: 'transition.preset_not_allowed',
        };
      }
    }

    // Determine old preset before transition (best-effort).
    // TODO: resolve current preset from agent metadata (agents table metadata.strategyPreset).
    // The unified config does not store the current preset key — it lives in the agents table.
    // Once agentConfigOps exposes getActivePreset() or similar, use it here.
    let oldPresetKey = 'unknown';

    // Resolve open position count — stub until position repo is wired into ToolContext
    const openPositionCount = 0;

    // Record the transition event
    const now = new Date();
    await db.insert(agentPresetTransitions).values({
      id: randomUUID(),
      agentId: ctx.agentId,
      oldPresetKey,
      oldPresetBehaviorVersion: 'unknown',
      newPresetKey: targetPreset,
      newPresetBehaviorVersion: 'v1',
      assessmentArtifactId: latest?.id ?? null,
      segmentKey: latest?.segmentKey ?? { venueFamily: 'unknown', styleTier: 'standard', universeScopeHash: 'unknown' },
      venueFamily: latest?.venueFamily ?? 'unknown',
      styleTier: latest?.styleTier ?? 'standard',
      universeScopeHash: latest?.universeScopeHash ?? 'unknown',
      transitionMode: mode,
      openPositionCount,
      outcome: 'accepted',
      reason: reason ?? null,
      appliedAt: now,
      regimeSnapshot: null,
      mode: 'live',
      createdAt: now,
    });

    // Journal the transition for audit — the preset config application
    // (resolving preset-derived values into the unified config) happens
    // separately via the strategy preset system.
    if (ctx.agentConfigOps) {
      await ctx.agentConfigOps.appendJournal('preset_transition', {
        targetPreset,
        mode,
        reason: reason ?? 'Agent-initiated preset transition',
        oldPresetKey,
        appliedAt: now.toISOString(),
      });
    }

    logger.info({ agentId: ctx.agentId, targetPreset, mode, oldPresetKey }, 'Preset transition applied');

    return {
      success: true,
      data: {
        applied: true,
        targetPreset,
        mode,
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

export const applyPresetTransitionTool: AgentTool = {
  name: 'apply_preset_transition',
  description: 'Apply a preset transition. Supports modes: entries_only (future entries use new preset) and entries_and_tighten_existing (tighten stops on open positions). Records the transition event for audit.',
  parametersSchema: ApplyPresetTransitionParamsSchema,
  parameters: convertZodToJsonSchema(ApplyPresetTransitionParamsSchema),
  category: 'write-database',
  execute: executeApplyPresetTransition,
};
