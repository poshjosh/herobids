import type { CapabilityReadiness } from '../../lib/api-client.js';

export interface AgentSkillPreset {
  value: string;
  label: string;
  description: string;
  skillIds: string[];
  capabilityFamilies: string[];
}

const OPERATOR_CONTEXT_MARKER = '\n\nOperator context:\n';
const LEGACY_PROMPT_CONTEXT = /\sExecution mode: (paper|shadow|live)\.(?:\sTrading capability selected(?: with provider hint (.+?))?\.)?(?:\sRisk tolerance: (conservative|moderate|aggressive)\.)?\s*$/;

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  paper: 'Paper',
  shadow: 'Shadow',
  live: 'Live',
};

export const CAPABILITY_FAMILY_LABELS: Record<string, string> = {
  trading: 'Trading',
};

export const AGENT_SKILL_PRESETS: AgentSkillPreset[] = [
  {
    value: 'trading',
    label: 'Trading-capable agent',
    description: 'Can use the trading capability after creation and continue setup from the agent page.',
    skillIds: ['bot-management'],
    capabilityFamilies: ['trading'],
  },
  {
    value: 'general',
    label: 'General-purpose agent',
    description: 'No trading capability selected. The agent can still operate on platform tasks and other skills.',
    skillIds: [],
    capabilityFamilies: [],
  },
];

export function formatExecutionMode(executionMode: string | null | undefined): string {
  if (!executionMode) {
    return 'Not set';
  }

  return EXECUTION_MODE_LABELS[executionMode] ?? executionMode;
}

export function formatCapabilityFamily(family: string): string {
  return CAPABILITY_FAMILY_LABELS[family] ?? family.replace(/[-_]/g, ' ');
}

export function formatCapabilityState(state: CapabilityReadiness['state']): string {
  if (state === 'ready') return 'Ready';
  if (state === 'degraded') return 'Degraded';
  if (state === 'provisioning') return 'Provisioning';
  if (state === 'revoked') return 'Revoked';
  return 'Unconfigured';
}

export function formatCapabilitySummary(capabilities: CapabilityReadiness[]): string {
  if (capabilities.length === 0) {
    return 'No capability setup required';
  }

  return capabilities
    .map((capability) => `${formatCapabilityFamily(capability.family)}: ${formatCapabilityState(capability.state)}`)
    .join(' · ');
}

export function extractAgentObjective(prompt: string): string {
  const markerIndex = prompt.indexOf(OPERATOR_CONTEXT_MARKER);
  if (markerIndex >= 0) {
    return prompt.slice(0, markerIndex).trim();
  }

  return prompt.replace(LEGACY_PROMPT_CONTEXT, '').trim();
}

export function extractAgentOperatorContext(prompt: string): string[] {
  const markerIndex = prompt.indexOf(OPERATOR_CONTEXT_MARKER);
  if (markerIndex >= 0) {
    return prompt
      .slice(markerIndex + OPERATOR_CONTEXT_MARKER.length)
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0);
  }

  const legacyMatch = prompt.match(LEGACY_PROMPT_CONTEXT);
  if (!legacyMatch) {
    return [];
  }

  const [, , providerHint, riskTolerance] = legacyMatch;
  const context: string[] = [];
  if (providerHint) {
    context.push(`Provider hint: ${providerHint}`);
  }
  if (riskTolerance) {
    context.push(`Risk tolerance: ${riskTolerance}`);
  }

  return context;
}