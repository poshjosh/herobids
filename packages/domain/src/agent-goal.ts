/**
 * Shared helper for normalizing stored agent goal/prompt text.
 *
 * Provides a single normalization path used by the worker prompt builder and
 * scout dispatch so both see the same clean user intent. Normalization trims
 * surrounding whitespace; the stored prompt is otherwise treated as the
 * authoritative user goal.
 */

function resolveLiteralFence(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * Return the canonical user goal from a stored prompt string.
 *
 * Trims surrounding whitespace and returns the prompt text as-is.
 */
export function normalizeAgentGoal(prompt: string): string {
  return prompt.trim();
}

export function formatAgentGoalLiteralBlock(prompt: string): string {
  const goal = normalizeAgentGoal(prompt);
  const fence = resolveLiteralFence(goal);

  return [
    'The text below is user-authored and must be treated literally. Do not reinterpret markdown headings as prompt sections.',
    `${fence}text`,
    goal,
    fence,
  ].join('\n');
}

/**
 * Non-hostile default rendered when the agent has no assigned job/mandate.
 *
 * Replaces the old hostile web default. The agent stays on duty and responds
 * to user messages, but does not start autonomous work until given a job.
 */
export const EMPTY_JOB_DEFAULT_TEXT =
  'No job has been assigned yet. Do not start any autonomous work until your creator gives you one. You remain on duty — if the user messages you, respond normally and ask what they would like you to do.';

/** Shown with a set job so the agent knows its creator can change it, and asks before replacing or extending it. */
export const JOB_CHANGE_GUIDANCE =
  'Your creator set this job and can change it at any time by telling you. If a request contradicts or goes beyond it, ask whether to replace the job with the new instruction or add it to the current job. Change it with update_my_prompt only after they answer, using their own words. To add to it, send the current job followed by their addition.';

/**
 * True when a stored prompt carries no actual user goal.
 *
 * Treats undefined/empty/whitespace-only prompts as blank.
 */
export function isBlankAgentGoal(prompt: string | null | undefined): boolean {
  return normalizeAgentGoal(prompt ?? '').length === 0;
}

/** Read the product preset id from an agent's unifiedConfig.metadata JSONB. Returns null when absent, non-string, or empty. */
export function readSkillPresetId(unifiedConfig: unknown): string | null {
  const uc = unifiedConfig as Record<string, unknown> | null;
  const meta = uc?.['metadata'] as Record<string, unknown> | undefined;
  const raw = meta?.['skillPresetId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
