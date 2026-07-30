import { describe, it, expect } from 'vitest';
import { EMAIL_SKILL, SYSTEM_SKILLS, TRADING_SKILL } from './skills.js';

describe('EMAIL_SKILL', () => {
  it('has id email', () => {
    expect(EMAIL_SKILL.id).toBe('email');
  });

  it('requires send_email tool', () => {
    expect(EMAIL_SKILL.requiredTools).toContain('send_email');
  });
});

describe('TRADING_SKILL', () => {
  it('has id trading', () => {
    expect(TRADING_SKILL.id).toBe('trading');
  });

  it('requires assess_strategy_preset tool', () => {
    expect(TRADING_SKILL.requiredTools).toContain('assess_strategy_preset');
  });

  it('requires change_strategy_preset tool', () => {
    expect(TRADING_SKILL.requiredTools).toContain('change_strategy_preset');
  });
});

describe('SYSTEM_SKILLS', () => {
  it('does not contain a skill with id gmail', () => {
    const gmailSkill = SYSTEM_SKILLS.find((s) => s.id === 'gmail');
    expect(gmailSkill).toBeUndefined();
  });
});
