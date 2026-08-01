import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import {
  ChangeStrategyPresetParamsSchema,
  isArtifactFresh,
  AGENT_MESSAGE_TYPES,
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

  // ── Gate: Reject tightening modes (out of scope for this slice) ───
  // entries_and_tighten_existing requires position-action infrastructure
  // that is not yet implemented. Refuse it explicitly so the agent
  // receives a clear signal that only entries_only is supported.
  if (mode === 'entries_and_tighten_existing' || mode === 'entries_and_full_transition') {
    logger.warn({ agentId: ctx.agentId, mode }, 'Blocked preset transition — tightening mode is not supported in this slice');
    return {
      success: false,
      error: `Transition mode "${mode}" is not supported. Only "entries_only" is available in this release.`,
      errorCode: 'transition.unsupported_mode',
    };
  }

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

  // ── Broker-mediated path: transitionPort not wired (agent container context) ──
  // ctx.redis.blpop is only wired in the agent container runtime — unit tests
  // and stubbed contexts omit it, so this check serves as a context sentinel.
  if (!transitionPort && ctx.publishToInbound && typeof ctx.redis.blpop === 'function') {
    const requestMessageId = randomUUID();
    const requestPayload = {
      ...parsed.data,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      requestMessageId,
    };

    try {
      await ctx.publishToInbound(AGENT_MESSAGE_TYPES.TOOL_CHANGE_STRATEGY_PRESET, requestPayload as Record<string, unknown>);

      const reply = await ctx.redis.blpop(`agent:preset:reply:${requestMessageId}`, 30);
      if (!reply) {
        return {
          success: false,
          error: 'Broker request timed out after 30s',
          errorCode: 'broker.timeout',
        };
      }

      const parsed = JSON.parse(reply[1]) as { result: ToolResult };
      return parsed.result;
    } catch (err) {
      logger.error({ err, agentId: ctx.agentId }, 'Broker-mediated change_strategy_preset failed');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Broker communication failed',
        errorCode: 'broker.communication_error',
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
    'Apply a strategy preset switch using the exact assessment artifact ID from a prior assess_strategy_preset call. ' +
    'This tool validates three things before applying: ' +
    '(1) Artifact identity — the artifact ID must match an existing assessment. ' +
    '(2) Freshness — the artifact must not be expired; check expiresAt and freshnessNote in the assessment response. ' +
    'If expired, call assess_strategy_preset again for a fresh artifact. ' +
    '(3) Allowed presets — the targetPreset must be in the assessment\'s allowedPresets list. ' +
    'Currently only entries_only mode is supported (existing positions are NOT modified). ' +
    'On failure, check the errorCode: ' +
    '"assessment.artifact_expired" means request a fresh assessment; ' +
    '"transition.preset_not_allowed" means the error includes the list of allowed presets — pick one from that list; ' +
    '"transition.unsupported_mode" means only entries_only is available.',
  parametersSchema: ChangeStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(ChangeStrategyPresetParamsSchema),
  category: 'write-database',
  execute: executeApplyPresetTransition,
};
