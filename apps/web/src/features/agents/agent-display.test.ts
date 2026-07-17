import { describe, expect, it } from 'vitest';
import { SKILL_PRESET_MAP } from '@herobids/domain';
import { formatObjectivePreview, resolveSkillPresetSkillIds } from './agent-display.js';

describe('skill preset resolution', () => {
  it('personal-assistant preset resolves to task-management, web-access, and gmail', () => {
    expect(resolveSkillPresetSkillIds('personal-assistant')).toEqual(['task-management', 'web-access', 'gmail']);
  });

  it('trading preset resolves to bot-management and trading', () => {
    expect(resolveSkillPresetSkillIds('trading')).toEqual(['bot-management', 'trading']);
  });

  it('custom preset clears all skillIds', () => {
    expect(resolveSkillPresetSkillIds('custom', ['programming', 'web-access'])).toEqual([]);
  });

  it('custom preset with no skills returns empty array', () => {
    expect(resolveSkillPresetSkillIds('custom')).toEqual([]);
  });

  it('domain SKILL_PRESET_MAP uses personal-assistant as the assistant preset key', () => {
    expect('personal-assistant' in SKILL_PRESET_MAP).toBe(true);
    expect('reminder' in SKILL_PRESET_MAP).toBe(false);
  });

  it('domain SKILL_PRESET_MAP personal-assistant maps to task-management, web-access, and gmail', () => {
    expect(SKILL_PRESET_MAP['personal-assistant']).toEqual(['task-management', 'web-access', 'gmail']);
  });

  it('formats long objectives as a compact preview', () => {
    expect(formatObjectivePreview('Grow my Solana portfolio\nwith disciplined entries and exits', 24)).toBe('Grow my Solana portfoli…');
  });
});
