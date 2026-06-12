import { describe, expect, it } from 'vitest';
import { SKILL_PRESET_MAP } from '@herobids/domain';
import { resolveSkillPresetSkillIds } from './agent-display.js';

describe('skill preset resolution', () => {
  it('personal-assistant preset resolves to task-management and web-access', () => {
    expect(resolveSkillPresetSkillIds('personal-assistant')).toEqual(['task-management', 'web-access']);
  });

  it('trading preset resolves to bot-management and trading', () => {
    expect(resolveSkillPresetSkillIds('trading')).toEqual(['bot-management', 'trading']);
  });

  it('custom preset preserves the supplied skillIds unchanged', () => {
    expect(resolveSkillPresetSkillIds('custom', ['programming', 'web-access'])).toEqual(['programming', 'web-access']);
  });

  it('custom preset with no skills returns empty array', () => {
    expect(resolveSkillPresetSkillIds('custom')).toEqual([]);
  });

  it('domain SKILL_PRESET_MAP uses personal-assistant as the assistant preset key', () => {
    expect('personal-assistant' in SKILL_PRESET_MAP).toBe(true);
    expect('reminder' in SKILL_PRESET_MAP).toBe(false);
  });

  it('domain SKILL_PRESET_MAP personal-assistant maps to task-management and web-access', () => {
    expect(SKILL_PRESET_MAP['personal-assistant']).toEqual(['task-management', 'web-access']);
  });
});
