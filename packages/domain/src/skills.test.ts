import { describe, it, expect } from 'vitest';
import { BASE_SKILL, EMAIL_SKILL, SYSTEM_SKILLS, TRADING_SKILL } from './skills.js';

// ── BASE_SKILL — skill management tools ─────────────────────────────────────

describe('BASE_SKILL', () => {
  it('has id "base"', () => {
    expect(BASE_SKILL.id).toBe('base');
  });

  it.each(['list_skills', 'add_skills', 'remove_skills', 'search_skills'])(
    'requiredTools includes %s',
    (toolName) => {
      expect(BASE_SKILL.requiredTools).toContain(toolName);
    },
  );

  it('instructions mention list_skills', () => {
    expect(BASE_SKILL.instructions).toContain('list_skills');
  });

  it('instructions mention add_skills', () => {
    expect(BASE_SKILL.instructions).toContain('add_skills');
  });

  it('instructions mention remove_skills', () => {
    expect(BASE_SKILL.instructions).toContain('remove_skills');
  });

  it('instructions contain skill management guidance text', () => {
    // Verify the instructions provide meaningful guidance about skill operations
    expect(BASE_SKILL.instructions).toContain('what skills you have');
    expect(BASE_SKILL.instructions).toContain('adopt platform skills');
    expect(BASE_SKILL.instructions).toContain('drop skills you no longer need');
    expect(BASE_SKILL.instructions).toContain('search_skills');
    expect(BASE_SKILL.instructions).toContain('skills.sh');
  });

  it('retains existing core tools alongside skill tools', () => {
    // Ensure adding skill tools did not remove pre-existing core tools
    const corePreviousTools = [
      'send_message', 'publish_artifact', 'set_memory', 'get_memory',
      'list_memory_keys', 'delete_memory', 'get_risk_limits',
      'get_account_summary', 'get_schema',
    ];
    for (const tool of corePreviousTools) {
      expect(BASE_SKILL.requiredTools).toContain(tool);
    }
  });
});

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
