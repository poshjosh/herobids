import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, ManageAgentSkillsResultSchema } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { createLogger } from '../logger.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

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
        data: {
          assigned,
          available,
          hint: 'For capabilities not listed here, use search_skills to search both platform skills and external skills discoverable through skills.sh.',
        },
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

        // Compute missing dependencies for add action
        let missingDependencies: Array<{ skillId: string; requiredBy: string }> | undefined;
        if (action === 'add' && ctx.skillOps) {
          try {
            const assignedSkills = await ctx.skillOps.listAssigned();
            const activeSet = new Set(activeSkills);
            const missing: Array<{ skillId: string; requiredBy: string }> = [];

            for (const addedId of result.skillIds) {
              const skill = assignedSkills.find(s => s.id === addedId);
              if (skill) {
                for (const dep of skill.dependsOn) {
                  if (!activeSet.has(dep)) {
                    missing.push({ skillId: dep, requiredBy: addedId });
                  }
                }
              }
            }

            if (missing.length > 0) {
              missingDependencies = missing;
            }
          } catch (err) {
            logger.warn({ err, agentId: ctx.agentId }, 'Failed to compute missing dependencies after add_skills');
          }
        }

        return {
          success: true,
          data: {
            [responseKey]: result.skillIds,
            activeSkills,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            ...(missingDependencies ? { missingDependencies } : {}),
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

// ── search_skills ───────────────────────────────────────────────────────────

const SearchSkillsParamsSchema = z.object({
  query: z.string().min(1).max(200),
});

const EXTERNAL_SEARCH_TIMEOUT_MS = 15_000;
const EXTERNAL_OUTPUT_MAX_BYTES = 8192;

function tokenizeQuery(query: string): string[] {
  return query.trim().split(/\s+/).filter(t => t.length > 0);
}

async function runExternalSkillSearch(
  tokens: string[],
  cwd: string,
): Promise<{ output: string } | { error: string }> {
  const sanitized = tokens
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .slice(0, 10);

  if (sanitized.length === 0) {
    return { error: 'No valid search tokens after sanitization' };
  }

  return new Promise((resolve) => {
    const child = spawn('npx', ['skills', 'find', ...sanitized], {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: EXTERNAL_SEARCH_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < EXTERNAL_OUTPUT_MAX_BYTES) {
        stdout += chunk.toString('utf-8').slice(0, EXTERNAL_OUTPUT_MAX_BYTES - stdout.length);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < EXTERNAL_OUTPUT_MAX_BYTES) {
        stderr += chunk.toString('utf-8').slice(0, EXTERNAL_OUTPUT_MAX_BYTES - stderr.length);
      }
    });

    child.on('error', (err) => {
      resolve({ error: `skills.sh CLI unavailable: ${err.message}` });
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve({ output: stdout.trim() });
      } else if (stderr.trim().length > 0) {
        resolve({ error: `skills.sh exited with code ${code}: ${stderr.trim().slice(0, 500)}` });
      } else {
        resolve({ error: `skills.sh exited with code ${code} (no output)` });
      }
    });
  });
}

const searchSkillsTool: AgentTool = {
  name: 'search_skills',
  description:
    'Search for skills by keyword across the platform catalog and external skills discoverable through skills.sh.',
  parametersSchema: SearchSkillsParamsSchema,
  parameters: convertZodToJsonSchema(SearchSkillsParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = SearchSkillsParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: query must be a non-empty string (max 200 chars)',
        errorCode: 'validation.invalid_params',
      };
    }
    const { query } = parsed.data;

    // Local platform search
    let localResults: Array<{
      id: string;
      name: string;
      description: string;
      isAssigned: boolean;
      dependsOn: string[];
    }> = [];
    if (ctx.skillOps) {
      try {
        localResults = await ctx.skillOps.search(query);
      } catch (err) {
        logger.warn({ err, agentId: ctx.agentId }, 'search_skills local search failed');
      }
    }

    // External search via skills.sh (best-effort)
    const tokens = tokenizeQuery(query);
    let external: { results: string } | { note: string };

    try {
      const { getWorkspacePaths } = await import('./workspace.js');
      const cwd = getWorkspacePaths(ctx.agentId).root;

      const extResult = await runExternalSkillSearch(tokens, cwd);
      if ('output' in extResult) {
        external = { results: extResult.output };
      } else {
        external = { note: extResult.error };
      }
    } catch (err) {
      external = { note: `External search unavailable: ${err instanceof Error ? err.message : 'unknown error'}` };
    }

    return {
      success: true,
      data: {
        local: { results: localResults },
        external,
      },
    };
  },
};

export const skillTools: AgentTool[] = [listSkillsTool, addSkillsTool, removeSkillsTool, searchSkillsTool];
