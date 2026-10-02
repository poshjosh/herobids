import { describe, expect, it } from 'vitest';
import { SKILL_PRESET_MAP } from '@herobids/domain';
import { formatObjectivePreview, resolveCapabilityFamilies } from './agent-display.js';

describe('suggested skills resolution', () => {
  it('domain SKILL_PRESET_MAP uses personal-assistant as the assistant preset key', () => {
    expect('personal-assistant' in SKILL_PRESET_MAP).toBe(true);
    expect('reminder' in SKILL_PRESET_MAP).toBe(false);
  });

  it('domain SKILL_PRESET_MAP personal-assistant maps to task-management, web-access, and email', () => {
    expect(SKILL_PRESET_MAP['personal-assistant']).toEqual(['task-management', 'web-access', 'email']);
  });

  it('formats long objectives as a compact preview', () => {
    expect(formatObjectivePreview('Grow my Solana portfolio\nwith disciplined entries and exits', 24)).toBe('Grow my Solana portfoli…');
  });
});

describe('resolveCapabilityFamilies', () => {
  it('returns an empty list when no skills carry capability families', () => {
    expect(resolveCapabilityFamilies([{ capabilityFamilies: [] }, { capabilityFamilies: [] }])).toEqual([]);
  });

  it('deduplicates and sorts families across skills', () => {
    expect(resolveCapabilityFamilies([
      { capabilityFamilies: ['trading'] },
      { capabilityFamilies: ['email'] },
      { capabilityFamilies: ['trading', 'email'] },
    ])).toEqual(['email', 'trading']);
  });

  it('returns a single family for a single-skill agent', () => {
    expect(resolveCapabilityFamilies([{ capabilityFamilies: ['trading'] }])).toEqual(['trading']);
  });
});
