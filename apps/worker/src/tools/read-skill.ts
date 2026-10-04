// Phase 4 T7 — `read_skill`: load an installed external skill's SKILL.md body
// from the agent workspace (no network — the install step at agent start does
// the fetch). A loaded skill's body stays in the prompt for the rest of the
// session (progressive disclosure, ADR 017 §2). Returns a clear "temporarily
// unavailable" message when this session's install failed.

import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { getWorkspacePaths } from './workspace.js';
import { readInstalledSkillBody } from '../external-skill-startup.js';
import { normalizeSourceRefToSlug } from '@herobids/db';
import { createLogger } from '../logger.js';

const logger = createLogger('tool:read-skill');

const ReadSkillParamsSchema = z.object({
  ref: z.string().min(1).describe('The skill ref to load, e.g. "traderton/skills/crypto-trading", as listed in the prompt.'),
});

async function executeReadSkill(params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = ReadSkillParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const ref = normalizeSourceRefToSlug(parsed.data.ref.trim());

  const session = ctx.externalSkillSession;
  if (session) {
    const assigned = new Set(session.assignedRefs().map(normalizeSourceRefToSlug));
    if (!assigned.has(ref)) {
      return {
        success: false,
        error: `Skill "${ref}" is not assigned to this agent. Use list_skills to see assigned skills, or add_skills to add it.`,
        errorCode: 'skill.not_assigned',
      };
    }
    const availability = session.availabilityFor(ref);
    if (availability && !availability.available) {
      return {
        success: true,
        data: {
          ref,
          loaded: false,
          available: false,
          message: `Skill "${ref}" is temporarily unavailable this session — its install failed${availability.unavailableReason ? ` (${availability.unavailableReason})` : ''}. Try again later or proceed without its guidance.`,
        },
      };
    }
  }

  const workspaceRoot = getWorkspacePaths(ctx.agentId).root;
  const body = await readInstalledSkillBody(workspaceRoot, ref);
  if (body === null) {
    return {
      success: true,
      data: {
        ref,
        loaded: false,
        available: false,
        message: `Skill "${ref}" is not installed in this workspace (install may have failed this session). Its guidance cannot be loaded right now.`,
      },
    };
  }

  session?.markLoaded(ref, body);
  logger.debug({ agentId: ctx.agentId, ref }, 'read_skill loaded skill body into session');

  return {
    success: true,
    data: {
      ref,
      loaded: true,
      available: true,
      // The body is now in the system prompt for the rest of the session; also
      // returned here so the agent can act on it this tick.
      instructions: body,
    },
  };
}

export const readSkillTool: AgentTool = {
  name: 'read_skill',
  description:
    "Load an external skill's full instructions by its ref (e.g. \"traderton/skills/crypto-trading\"). " +
    'The prompt lists each external skill by name and description; call read_skill to load the one you need. ' +
    'Once loaded, the skill stays available for the rest of the session.',
  parametersSchema: ReadSkillParamsSchema,
  parameters: convertZodToJsonSchema(ReadSkillParamsSchema),
  category: 'read-filesystem',
  execute: executeReadSkill,
};
