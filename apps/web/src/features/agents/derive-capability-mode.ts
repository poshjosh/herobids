import type { CapabilityMode } from './CapabilitySelector.js';
import { hasCapabilityFamily } from './agent-display.js';

export function deriveCapabilityMode(
  skills: Array<{ capabilityFamilies: string[] }>,
  goal: string,
): CapabilityMode {
  const hasTradingSkill = hasCapabilityFamily(skills, 'trading');
  const hasIntelligence = goal.trim().length > 0;
  if (hasTradingSkill && hasIntelligence) return 'hybrid';
  if (hasIntelligence) return 'intelligence';
  return 'technical';
}
