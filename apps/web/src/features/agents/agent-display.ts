import type { IntlShape } from 'react-intl';
import type { CapabilityReadiness, Skill } from '../../lib/api-client.js';
// These constants mirror the normalization logic in packages/domain/src/agent-goal.ts.
// They must be kept in sync if the stored-prompt format ever changes.
const OPERATOR_CONTEXT_MARKER = '\n\nOperator context:\n';
const LEGACY_PROMPT_CONTEXT = /\sExecution mode: (paper|shadow|live)\.(?:\sTrading capability selected(?: with provider hint (.+?))?\.)?(?:\sRisk tolerance: (conservative|moderate|aggressive)\.)?\s*$/;
const GENERATED_OPERATOR_CONTEXT_LINE = /^- (Selected skills:|Trading capability selected\.|Selected trading (?:binding|connection):|Risk tolerance:)/;

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  paper: 'Test',
  shadow: 'Test',
  test: 'Test',
  live: 'Live',
};

export const CAPABILITY_FAMILY_LABELS: Record<string, string> = {
  trading: 'Trading',
};

export type SkillPresetId = 'trading' | 'direct-trading' | 'trading-assistant' | 'personal-assistant' | 'custom';

const SKILL_PRESET_SKILL_IDS: Record<Exclude<SkillPresetId, 'custom'>, string[]> = {
  trading: ['trading', 'bot-management'],
  'direct-trading': ['trading'],
  'trading-assistant': ['trading'],
  'personal-assistant': ['task-management', 'web-access', 'email'],
};

const SKILL_PRESET_DISPLAY_KEYS: Record<Exclude<SkillPresetId, 'custom'>, string> = {
  trading: 'agents.skillPresetId.trading',
  'direct-trading': 'agents.skillPresetId.directTrading',
  'trading-assistant': 'agents.skillPresetId.tradingAssistant',
  'personal-assistant': 'agents.skillPresetId.personalAssistant',
};

/** Format a skillPresetId value into a human-readable label. */
export function formatSkillPresetId(presetId: string | null | undefined, intl?: IntlShape): string | null {
  if (!presetId) return null;
  const key = SKILL_PRESET_DISPLAY_KEYS[presetId as Exclude<SkillPresetId, 'custom'>];
  if (key) return formatMessageOrFallback(intl, key, presetId);
  if (presetId === 'custom') return formatMessageOrFallback(intl, 'agents.create.skillPreset.custom', 'Custom');
  return presetId;
}

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

export function listSelectableSkills(skills: Skill[]): Skill[] {
  return skills
    .filter((skill) => skill.id !== 'base' && skill.isSelectable)
    .slice()
    .sort((left, right) => {
      const sourceOrder: Record<Skill['sourceKind'], number> = {
        system: 0,
        user: 1,
      };

      const sourceDelta = sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind];
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

export function resolveSkillPresetSkillIds(preset: SkillPresetId, _currentSkillIds: string[] = []): string[] {
  if (preset === 'custom') {
    return [];
  }

  return [...SKILL_PRESET_SKILL_IDS[preset]];
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

const GOAL_PLACEHOLDER_BY_PRESET: Record<SkillPresetId, string> = {
  trading: 'agents.create.goalPlaceholder.trading',
  'direct-trading': 'agents.create.goalPlaceholder.trading',
  'trading-assistant': 'agents.create.goalPlaceholder.trading',
  'personal-assistant': 'agents.create.goalPlaceholder.personalAssistant',
  custom: 'agents.create.goalPlaceholder.custom',
};

/** Return the i18n key for the goal placeholder matching the given preset. */
export function resolveGoalPlaceholderKey(preset: SkillPresetId): string {
  return GOAL_PLACEHOLDER_BY_PRESET[preset];
}

export function formatExecutionMode(executionMode: string | null | undefined, intl?: IntlShape): string {
  if (!executionMode) {
    return formatMessageOrFallback(intl, 'agents.executionMode.not_set', 'Not set');
  }

  const fallback = EXECUTION_MODE_LABELS[executionMode] ?? executionMode;
  return formatMessageOrFallback(intl, `agents.executionMode.${executionMode}`, fallback);
}

export function formatAuthorizationMode(mode: string | null | undefined, intl?: IntlShape): string {
  if (mode === 'approval_required') {
    return formatMessageOrFallback(intl, 'agents.authorizationMode.display.approvalRequired', 'Approval required');
  }
  return formatMessageOrFallback(intl, 'agents.authorizationMode.display.direct', 'Direct');
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
  const markerIndex = prompt.indexOf(OPERATOR_CONTEXT_MARKER);
  if (markerIndex >= 0) {
    const contextLines = prompt
      .slice(markerIndex + OPERATOR_CONTEXT_MARKER.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (contextLines.length > 0 && contextLines.every((line) => GENERATED_OPERATOR_CONTEXT_LINE.test(line))) {
      return prompt.slice(0, markerIndex).trim();
    }
  }

  return prompt.replace(LEGACY_PROMPT_CONTEXT, '').trim();
}

