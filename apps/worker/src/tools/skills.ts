import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, ManageAgentSkillsResultSchema } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('tools:skills');

const SKILLS_REPLY_TIMEOUT_S = 15;

// ── list_skills ─────────────────────────────────────────────────────────────

const ListSkillsParamsSchema = z.object({});

const listSkillsTool: AgentTool = {
  name: 'list_skills',
  description:
    'List skills assigned to this agent and skills available to add.',
  parametersSchema: ListSkillsParamsSchema,
  parameters: convertZodToJsonSchema(ListSkillsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.skillOps) {
      return {
        success: false,
        error: 'Skill operations not available in this context',
        errorCode: 'skill.ops_unavailable',
      };
    }

    try {
      const [assigned, available] = await Promise.all([
        ctx.skillOps.listAssigned(),
        ctx.skillOps.listAvailable(),
      ]);

      return {
        success: true,
        data: { assigned, available },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error({ err, agentId: ctx.agentId }, 'list_skills failed');
      return {
        success: false,
        error: `Failed to list skills: ${message}`,
        errorCode: 'skill.list_failed',
      };
    }
  },
};

// ── Shared broker-mediated skill mutation logic ─────────────────────────────

const SkillMutationParamsSchema = z.object({
  skillIds: z.array(z.string().min(1)).min(1).max(10),
});

async function executeSkillMutation(
  action: 'add' | 'remove',
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = SkillMutationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      success: false,
      error: 'Invalid parameters: skillIds must be an array of 1–10 non-empty strings',
      errorCode: 'validation.invalid_params',
    };
  }
  const { skillIds } = parsed.data;

  if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
    return {
      success: false,
      error: 'Broker communication not available in this context',
      errorCode: 'skill.broker_unavailable',
    };
  }

  const requestMessageId = randomUUID();

  try {
    await ctx.publishToInbound(
      AGENT_MESSAGE_TYPES.MANAGE_AGENT_SKILLS,
      { action, skillIds, requestMessageId } as Record<string, unknown>,
    );

    const reply = await ctx.redis.blpop(
      `agent:skills:reply:${requestMessageId}`,
      SKILLS_REPLY_TIMEOUT_S,
    );

    if (!reply) {
      return {
        success: false,
        retryable: true,
        error: 'Timed out waiting for broker reply',
        errorCode: 'broker.timeout',
      };
    }

    const parsed = ManageAgentSkillsResultSchema.safeParse(JSON.parse(reply[1]));
    if (!parsed.success) {
      logger.error({ agentId: ctx.agentId, action, parseErrors: parsed.error.issues }, 'Malformed broker reply for skill mutation');
      return {
        success: false,
        error: 'Received malformed reply from broker',
        errorCode: 'broker.malformed_reply',
      };
    }

    const result = parsed.data;

    if (result.status === 'error') {
      return {
        success: false,
        error: result.error ?? 'Skill mutation failed',
        errorCode: result.errorCode ?? 'skill.mutation_failed',
      };
    }

    // Hot-reload: refresh runtime descriptor + tool visibility
    const responseKey = action === 'add' ? 'added' : 'removed';
    if (ctx.onSkillsChanged) {
      try {
        const activeSkills = await ctx.onSkillsChanged();
        return {
          success: true,
          data: {
            [responseKey]: result.skillIds,
            activeSkills,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          },
        };
      } catch (reloadErr) {
        // DB write succeeded but hot-reload failed — still report success
        logger.warn({ err: reloadErr, agentId: ctx.agentId, action }, 'onSkillsChanged failed after successful skill mutation');
        return {
          success: true,
          data: {
            [responseKey]: result.skillIds,
            note: 'Skill change saved. Hot-reload failed — changes take effect next tick.',
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          },
        };
      }
    }

    // Fallback: onSkillsChanged not wired
    return {
      success: true,
      data: {
        [responseKey]: result.skillIds,
        note: 'Skill change saved. Changes take effect next tick.',
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
    };
  } catch (err) {
    logger.error({ err, agentId: ctx.agentId, action }, 'Skill mutation broker communication failed');
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Broker communication failed',
      errorCode: 'broker.communication_error',
    };
  }
}

// ── add_skills ──────────────────────────────────────────────────────────────

const addSkillsTool: AgentTool = {
  name: 'add_skills',
  description:
    'Add skills to this agent from the skill catalog. Skills become available immediately.',
  parametersSchema: SkillMutationParamsSchema,
  parameters: convertZodToJsonSchema(SkillMutationParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    return executeSkillMutation('add', params, ctx);
  },
};

// ── remove_skills ───────────────────────────────────────────────────────────

const removeSkillsTool: AgentTool = {
  name: 'remove_skills',
  description:
    'Remove skills from this agent. Tools from removed skills become unavailable immediately.',
  parametersSchema: SkillMutationParamsSchema,
  parameters: convertZodToJsonSchema(SkillMutationParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    return executeSkillMutation('remove', params, ctx);
  },
};

export const skillTools: AgentTool[] = [listSkillsTool, addSkillsTool, removeSkillsTool];
