import type { IntlShape } from 'react-intl';
import type { CapabilityReadiness, Skill } from '../../lib/api-client.js';

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  paper: 'Test',
  shadow: 'Test',
  live: 'Live',
};

export const CAPABILITY_FAMILY_LABELS: Record<string, string> = {
  trading: 'Trading',
  email: 'Email',
};

function formatMessageOrFallback(intl: IntlShape | undefined, id: string, fallback: string): string {
  if (!intl) {
    return fallback;
  }

  try {
    return intl.formatMessage({ id, defaultMessage: fallback });
  } catch {
    return fallback;
  }
}

/**
 * Group order for the skill picker (Phase 4 T9b, EC-17): system → backend-approved
 * → user → other external. Backend-approved external skills (config-driven, via
 * the API's isBackendApproved flag — no backend name in the web app) sort above
 * ordinary external skills.
 */
function skillGroupRank(skill: Skill): number {
  if (skill.sourceKind === 'system') return 0;
  if (skill.isBackendApproved) return 1;
  if (skill.sourceKind === 'user') return 2;
  return 3; // other external
}

export function listSelectableSkills(skills: Skill[]): Skill[] {
  return skills
    .filter((skill) => skill.id !== 'base' && skill.isSelectable)
    .slice()
    .sort((left, right) => {
      const sourceDelta = skillGroupRank(left) - skillGroupRank(right);
      if (sourceDelta !== 0) {
        return sourceDelta;
      }

      const publicationOrder: Record<Skill['publicationStatus'], number> = {
        published: 0,
        private: 1,
        draft: 2,
        delisted: 3,
        archived: 4,
      };
      const publicationDelta = publicationOrder[left.publicationStatus] - publicationOrder[right.publicationStatus];
      if (publicationDelta !== 0) {
        return publicationDelta;
      }

      const nameDelta = left.name.localeCompare(right.name);
      if (nameDelta !== 0) {
        return nameDelta;
      }

      return left.id.localeCompare(right.id);
    });
}

export function formatSkillSelection(skills: Array<{ name: string }>, intl?: IntlShape): string {
  return skills.length > 0 ? skills.map((skill) => skill.name).join(', ') : formatMessageOrFallback(intl, 'agents.skills.baseOnly', 'Base only');
}

export function formatObjectivePreview(objective: string, maxLength = 160): string {
  const compactObjective = objective.replace(/\s+/g, ' ').trim();

  if (compactObjective.length <= maxLength) {
    return compactObjective;
  }

  return `${compactObjective.slice(0, maxLength - 1).trimEnd()}…`;
}

export function hasCapabilityFamily(skills: Array<{ capabilityFamilies: string[] }>, family: string): boolean {
  return skills.some((skill) => skill.capabilityFamilies.includes(family));
}

/**
 * Phase 4 (EC-3): does the agent's SELECTED skill set carry a capability family?
 * Replaces hard-coded skill-id checks (`skillIds.includes('bot-management')`) in
 * the agent forms — the family comes from the skill views (config-driven for
 * backend-approved external skills), not a hard-coded id.
 */
export function selectedSkillsHaveCapabilityFamily(skillIds: string[], skills: Skill[], family: string): boolean {
  return hasCapabilityFamily(resolveSelectedSkills(skillIds, skills), family);
}

/**
 * Derive the distinct, alphabetically-sorted capability families carried by the
 * given skills (deduplicated). Used for the generic "Capabilities: a, b" summary
 * line, which lists families rather than a hardcoded trading readiness state.
 */
export function resolveCapabilityFamilies(skills: Array<{ capabilityFamilies: string[] }>): string[] {
  const families = new Set<string>();
  for (const skill of skills) {
    for (const family of skill.capabilityFamilies) {
      families.add(family);
    }
  }
  return [...families].sort();
}

export function resolveSelectedSkills(skillIds: string[], skills: Skill[]): Skill[] {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill] as const));

  return skillIds
    .map((skillId) => skillsById.get(skillId))
    .filter((skill): skill is Skill => skill !== undefined);
}

/**
 * Build a list of prompt hints from the selected skills.
 * Each entry pairs the skill name with its hint for display near the goal field.
 */
export function buildSkillPromptHints(
  skillIds: string[],
  skills: Skill[],
): Array<{ skillName: string; hint: string }> {
  const selected = resolveSelectedSkills(skillIds, skills);
  return selected
    .filter((skill) => skill.promptHint)
    .map((skill) => ({ skillName: skill.name, hint: skill.promptHint! }));
}

/**
 * Return the best promptTemplate from the selected skills, if any.
 * Uses the first non-empty template found (priority: first selected skill wins).
 */
export function resolvePromptTemplate(skillIds: string[], skills: Skill[]): string | null {
  const selected = resolveSelectedSkills(skillIds, skills);
  for (const skill of selected) {
    if (skill.promptTemplate) return skill.promptTemplate;
  }
  return null;
}

/**
 * Return the best placeholder text for the goal field.
 * Uses promptHint from the first skill that has one, falling back to a generic placeholder key.
 */
export function resolveGoalPlaceholder(skillIds: string[], skills: Skill[]): string | null {
  const selected = resolveSelectedSkills(skillIds, skills);
  for (const skill of selected) {
    if (skill.promptHint) return skill.promptHint;
  }
  return null;
}

/**
 * Return the i18n key for the goal-field placeholder, derived from the agent's
 * selected skills rather than any "type". Trading-family agents get the trading
 * placeholder; everything else falls back to the generic custom placeholder.
 * (A skill's own `promptHint` still takes precedence via `resolveGoalPlaceholder`.)
 */
export function resolveGoalPlaceholderKey(skillIds: string[], skills: Skill[]): string {
  const selected = resolveSelectedSkills(skillIds, skills);
  if (hasCapabilityFamily(selected, 'trading')) {
    return 'agents.create.goalPlaceholder.trading';
  }
  return 'agents.create.goalPlaceholder.custom';
}

export function formatExecutionMode(executionMode: string | null | undefined, intl?: IntlShape): string {
  if (!executionMode) {
    return formatMessageOrFallback(intl, 'agents.executionMode.not_set', 'Not set');
  }

  const fallback = EXECUTION_MODE_LABELS[executionMode] ?? executionMode;
  return formatMessageOrFallback(intl, `agents.executionMode.${executionMode}`, fallback);
}

export function formatCapabilityFamily(family: string, intl?: IntlShape): string {
  const fallback = CAPABILITY_FAMILY_LABELS[family] ?? family.replace(/[-_]/g, ' ');
  return formatMessageOrFallback(intl, `agents.capabilityFamily.${family}`, fallback);
}

export function formatCapabilityState(state: CapabilityReadiness['state'], intl?: IntlShape): string {
  if (state === 'ready') return formatMessageOrFallback(intl, 'agents.capabilityState.ready', 'Ready');
  if (state === 'degraded') return formatMessageOrFallback(intl, 'agents.capabilityState.degraded', 'Degraded');
  if (state === 'provisioning') return formatMessageOrFallback(intl, 'agents.capabilityState.provisioning', 'Provisioning');
  if (state === 'revoked') return formatMessageOrFallback(intl, 'agents.capabilityState.revoked', 'Revoked');
  return formatMessageOrFallback(intl, 'agents.capabilityState.unconfigured', 'Unconfigured');
}

export function formatCapabilitySummary(capabilities: CapabilityReadiness[], intl?: IntlShape): string {
  if (capabilities.length === 0) {
    return formatMessageOrFallback(intl, 'agents.summary.noCapabilitySetup', 'No capability setup required');
  }

  return capabilities
    .map((capability) => `${formatCapabilityFamily(capability.family, intl)}: ${formatCapabilityState(capability.state, intl)}`)
    .join(' · ');
}

export function extractAgentObjective(prompt: string): string {
  return prompt.trim();
}

