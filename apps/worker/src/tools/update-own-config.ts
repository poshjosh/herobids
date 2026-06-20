import { z } from 'zod';
import { TechnicalConfigSchema, IntelligenceConfigSchema, UnifiedAgentConfigSchema } from '@herobids/domain';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

const UpdateOwnConfigPayloadSchema = z.object({
  technical: TechnicalConfigSchema.or(z.null()).optional(),
  intelligence: IntelligenceConfigSchema.or(z.null()).optional(),
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).optional(),
    positionSizeMode: z.enum(['fixed', 'percent_equity']).optional(),
    fixedPositionSize: z.string().optional(),
  }).optional(),
  risk: z.object({
    maxPositions: z.number().int().min(1).optional(),
    maxPositionSizePct: z.number().min(0).max(100).optional(),
    dailyMaxLossPct: z.number().min(0).max(100).optional(),
    stopLossPct: z.number().min(0).optional(),
    takeProfitPct: z.number().min(0).optional(),
  }).optional(),
});

type UpdateOwnConfigPayload = z.infer<typeof UpdateOwnConfigPayloadSchema>;

const updateOwnConfigTool: AgentTool = {
  name: 'update_own_config',
  description: "Update this agent's own configuration. Can add, modify, or remove the technical, intelligence, execution, and risk sections. Cannot remove both technical and intelligence (would deactivate reasoning). Changes are persisted to DB and take effect on the next cycle.",
  parametersSchema: UpdateOwnConfigPayloadSchema,
  parameters: convertZodToJsonSchema(UpdateOwnConfigPayloadSchema),
  category: 'write-database',
  promptGuidance: 'Use to add/remove technical scanning, change execution mode (paper→shadow→live), or adjust risk limits. Set technical to null to remove technical scanning. Cannot go directly from null/unknown mode to live.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentConfigOps) {
      return { success: false, error: 'agent config ops not available in this context' };
    }

    const p = params as UpdateOwnConfigPayload;
    const ops = ctx.agentConfigOps;

    // Read current config
    const currentConfig = await ops.getCurrentConfig();

    // Guard: removing technical when there is no intelligence would deactivate the agent
    const wouldRemoveTechnical = 'technical' in p && p.technical === null;
    const hasIntelligence = !!currentConfig?.intelligence;

    if (wouldRemoveTechnical && !hasIntelligence) {
      return {
        success: false,
        error: 'Cannot remove technical config: agent has no intelligence config either. Removing technical would leave the agent with no active configuration mode.',
      };
    }

    // Live mode safety gate
    const requestedMode = p.execution?.mode;
    if (requestedMode === 'live') {
      const currentMode = currentConfig?.execution?.mode ?? null;
      if (currentMode === null || currentMode === undefined) {
        // null/unknown → live: always rejected
        return {
          success: false,
          error: "Cannot promote directly to live mode from an unconfigured state. Start with paper or shadow mode first.",
        };
      }
      if (currentMode === 'paper') {
        const paperCycles = ops.getLlmTickCount();
        const minRequired = ops.getMinPaperCyclesBeforeLive();
        if (paperCycles < minRequired) {
          return {
            success: false,
            error: `Cannot promote from paper to live: only ${paperCycles} paper cycle(s) completed, need at least ${minRequired}. Continue in paper mode to accumulate more cycles.`,
          };
        }
      }
      // shadow → live: always allowed
    }

    // Deep merge update with current config
    const mergedConfig = deepMergeConfig(currentConfig, p);

    // Validate merged result — must have technical or intelligence
    const validation = UnifiedAgentConfigSchema.safeParse(mergedConfig);
    if (!validation.success) {
      const issues = validation.error.issues
        .map(({ path, message }) => `${path.length > 0 ? path.join('.') : 'root'}: ${message}`)
        .join('; ');
      return { success: false, error: `Config validation failed: ${issues}` };
    }

    const newConfig = validation.data;
    const oldConfig = currentConfig;

    // Determine new execution mode for the executionMode column
    const newExecutionMode = newConfig.execution?.mode;

    // Persist to DB
    await ops.persistConfig(newConfig, newExecutionMode);

    // Journal the change
    await ops.appendJournal('agent.config_updated', {
      before: oldConfig ?? null,
      after: newConfig,
      updatedBy: 'agent',
    });

    // Signal actor to reload config (best effort — fire and forget)
    ops.notifyActorConfigUpdate(newConfig).catch(() => undefined);

    return {
      success: true,
      data: {
        ok: true,
        note: 'Config updated. Technical scan loop changes take effect immediately. Execution mode changes take effect on next restart.',
        config: newConfig,
      },
    };
  },
};

/**
 * Deep-merges a partial config update into the current config.
 * - If `technical` is null in the update, the technical field is removed.
 * - If `technical` is an object, it replaces (not merges) the technical section.
 * - If `intelligence` is null, the intelligence field is removed.
 * - If `intelligence` is an object, it replaces (not merges) the intelligence section.
 * - execution and risk sub-objects are shallow-merged with existing values.
 */
function deepMergeConfig(
  current: Record<string, unknown> | null | undefined,
  update: UpdateOwnConfigPayload,
): Record<string, unknown> {
  const base: Record<string, unknown> = current ? { ...current } : {};

  if ('technical' in update) {
    if (update.technical === null) {
      delete base.technical;
    } else if (update.technical !== undefined) {
      base.technical = update.technical;
    }
  }

  if ('intelligence' in update) {
    if (update.intelligence === null) {
      delete base.intelligence;
    } else if (update.intelligence !== undefined) {
      base.intelligence = update.intelligence;
    }
  }

  if (update.execution !== undefined) {
    const existing = (base.execution as Record<string, unknown> | undefined) ?? {};
    base.execution = { ...existing, ...update.execution };
  }

  if (update.risk !== undefined) {
    const existing = (base.risk as Record<string, unknown> | undefined) ?? {};
    base.risk = { ...existing, ...update.risk };
  }

  return base;
}

export const updateOwnConfigTools: AgentTool[] = [updateOwnConfigTool];
