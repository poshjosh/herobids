// Phase 4 T7 — `read_skill`: load an installed external skill's SKILL.md body
// from the agent workspace (no network — the install step at agent start does
// the fetch). A loaded skill's body stays in the prompt for the rest of the
// session (progressive disclosure, ADR 017 §2). Returns a clear "temporarily
// unavailable" message when this session's install failed.

import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { getWorkspacePaths } from './workspace.js';
import { readInstalledSkillBody, stripFrontmatter } from '../external-skill-startup.js';
import { normalizeSourceRefToSlug } from '@herobids/db';
import { createLogger } from '../logger.js';
import { activateExternalSkill, npxSkillsCliInstaller } from './skills.js';
import { SYSTEM_SKILL_SLUGS } from '@herobids/domain';

const logger = createLogger('tool:read-skill');

/**
 * Shape and kind checks on a raw skill ref. Runs before any install or session
 * lookup, so a system or malformed ref never reaches the skills.sh CLI.
 * Returns an error result, or null when the ref is a plausible external ref.
 * Shared with `load_skill`.
 */
export function checkSkillRefForRead(rawRef: string): ToolResult | null {
  if (rawRef.startsWith('system/')) {
    if (SYSTEM_SKILL_SLUGS.has(rawRef)) {
      return {
        success: false,
        error: `"${rawRef}" is a system skill. read_skill only loads external skills. Use add_skills to enable it; its tools then become available directly.`,
        errorCode: 'skill.not_external',
      };
    }
    const validSlugs = [...SYSTEM_SKILL_SLUGS.keys()].join(', ');
    return {
      success: false,
      error: `"${rawRef}" is not a known system skill. Valid system skills: ${validSlugs}.`,
      errorCode: 'skill.unknown',
    };
  }
  if (!rawRef.includes('/')) {
    return {
      success: false,
      error: `"${rawRef}" is not a valid skill ref. System skills use slugs such as system/programming. External skills use owner/repo/skill. Use search_skills to find a skill.`,
      errorCode: 'skill.invalid_ref',
    };
  }
  return null;
}

/**
 * Which backend tools the loaded skill can call this session, and why a tagged tool
 * is missing. Lets the agent see its real capabilities instead of guessing.
 */
function toolReportFields(
  report: { outcome: string; toolNames: string[]; droppedTools: Array<{ name: string; reason: string }> } | undefined,
): Record<string, unknown> {
  if (!report) return {};
  const droppedNames = report.droppedTools.map((tool) => tool.name).join(', ');
  let toolNotice: string | undefined;
  if (report.outcome === 'backend_unreachable') {
    toolNotice = "This skill's backend tools are unavailable this session (backend unreachable). Its guidance is loaded, but its tools will not work until discovery succeeds.";
  } else if (report.toolNames.length === 0) {
    toolNotice = droppedNames
      ? `No backend tools are visible for this skill. Not visible: ${droppedNames}.`
      : 'No backend tools are visible for this skill yet.';
  } else if (report.droppedTools.length > 0) {
    toolNotice = `Some tools for this skill are not visible: ${droppedNames}.`;
  }
  return {
    tools: report.toolNames,
    droppedTools: report.droppedTools,
    ...(toolNotice ? { toolNotice } : {}),
  };
}

const ReadSkillParamsSchema = z.object({
  ref: z.string().min(1).describe('The skill ref to load, e.g. "traderton/skills/crypto-trading", as listed in the prompt.'),
});

/**
 * Install an assigned external skill whose SKILL.md is missing from the workspace,
 * then re-read it. Returns the body, or the reason the install did not produce one.
 */
async function installMissingSkill(
  ref: string,
  ctx: ToolContext,
  workspaceRoot: string,
): Promise<{ body: string } | { error: string }> {
  const installer = ctx.externalSkillInstaller ?? npxSkillsCliInstaller;
  const activation = await activateExternalSkill({ ref, workspaceRoot, installer });
  if (activation.status === 'install_failed') return { error: activation.reason };
  return { body: stripFrontmatter(activation.content) };
}

async function executeReadSkill(params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = ReadSkillParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const rawRef = parsed.data.ref.trim();
  const refError = checkSkillRefForRead(rawRef);
  if (refError) return refError;
  const ref = normalizeSourceRefToSlug(rawRef);

  const session = ctx.externalSkillSession;
  if (session) {
    const assigned = new Set(session.assignedRefs().map(normalizeSourceRefToSlug));
    if (!assigned.has(ref)) {
      return {
        success: false,
        error: `Skill "${ref}" is not assigned to this agent. Use list_skills to see assigned skills, or add_skills to add it. If it was added in this session, it may take effect on the next tick.`,
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
  let body = await readInstalledSkillBody(workspaceRoot, ref);
  if (body === null) {
    // Assigned but not installed in this workspace (for example, assigned without an
    // install). Install it now and re-read; a failed install is reported, not hidden.
    const installed = await installMissingSkill(ref, ctx, workspaceRoot);
    if ('error' in installed) {
      return {
        success: true,
        data: {
          ref,
          loaded: false,
          available: false,
          message: `Skill "${ref}" is not installed in this workspace and the install failed: ${installed.error}. Its guidance cannot be loaded right now.`,
        },
      };
    }
    body = installed.body;
  }

  session?.markLoaded(ref, body);
  const report = session?.toolReportFor?.(ref);
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
      ...toolReportFields(report),
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
