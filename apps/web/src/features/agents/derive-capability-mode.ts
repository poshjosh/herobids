import type { CapabilityMode } from './CapabilitySelector.js';

export function deriveCapabilityMode(skillIds: string[], goal: string): CapabilityMode {
  const hasTradingSkill = skillIds.includes('trading') || skillIds.includes('bot-management');
  const hasIntelligence = goal.trim().length > 0;
  if (hasTradingSkill && hasIntelligence) return 'both';
  if (hasIntelligence) return 'intelligence';
  return 'technical';
}
