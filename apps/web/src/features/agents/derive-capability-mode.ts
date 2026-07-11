import type { CapabilityMode } from './CapabilitySelector.js';
import { hasCapabilityFamily } from './agent-display.js';

export function deriveCapabilityMode(
  skills: Array<{ capabilityFamilies: string[] }>,
  _goal: string,
): CapabilityMode {
  const hasTradingSkill = hasCapabilityFamily(skills, 'trading');
  if (hasTradingSkill) return 'hybrid';
  return 'intelligence';
}
