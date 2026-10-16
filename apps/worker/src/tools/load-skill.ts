// `load_skill` — one call to add an external skill and load its instructions.
// Composes `add_skills` (assign + install) and `read_skill` (load the body into
// the session). The add is skipped when the skill is already assigned, so a
// repeat call only reads the body.

import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { normalizeSourceRefToSlug } from '@herobids/db';
import { convertZodToJsonSchema } from './registry.js';
import { addSkillsTool } from './skills.js';
import { readSkillTool, checkSkillRefForRead } from './read-skill.js';

const LoadSkillParamsSchema = z.object({
  ref: z.string().min(1).describe('The external skill ref, e.g. "traderton/skills/crypto-trading", as listed by search_skills.'),
});

async function executeLoadSkill(params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = LoadSkillParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: 'Invalid parameters', errorCode: 'validation.invalid_params' };
  }
  const rawRef = parsed.data.ref.trim();
  const refError = checkSkillRefForRead(rawRef);
  if (refError) return refError;
  const ref = normalizeSourceRefToSlug(rawRef);

  const session = ctx.externalSkillSession;
  const alreadyAssigned = session
    ? session.assignedRefs().map(normalizeSourceRefToSlug).includes(ref)
    : false;

  let addData: Record<string, unknown> | undefined;
  if (!alreadyAssigned) {
    const addResult = await addSkillsTool.execute({ skillIds: [rawRef] }, ctx);
    if (!addResult.success) return addResult;
    addData = addResult.data as Record<string, unknown> | undefined;
  }

  const readResult = await readSkillTool.execute({ ref: rawRef }, ctx);
  if (!readResult.success) {
    if (readResult.errorCode === 'skill.not_assigned') {
      // The add succeeded but the assignment is not live in this session yet
      // (hot-reload did not run). Tell the agent to retry rather than fail.
      return {
        success: false,
        retryable: true,
        error: `Skill "${ref}" was added but is not active yet. Call load_skill again on the next tick.`,
        errorCode: 'skill.activation_pending',
      };
    }
    return readResult;
  }

  const readData = readResult.data as Record<string, unknown>;
  return {
    success: true,
    data: {
      ...readData,
      added: !alreadyAssigned,
      ...(addData ? { add: addData } : {}),
    },
  };
}

export const loadSkillTool: AgentTool = {
  name: 'load_skill',
  description:
    'Add an external skill to this agent and load its full instructions in one call (same as add_skills then read_skill). ' +
    'Use this when you need a skill now. The instructions stay available for the rest of the session.',
  parametersSchema: LoadSkillParamsSchema,
  parameters: convertZodToJsonSchema(LoadSkillParamsSchema),
  category: 'write-database',
  execute: executeLoadSkill,
};
