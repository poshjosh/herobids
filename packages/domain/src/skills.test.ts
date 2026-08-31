import { describe, it, expect } from 'vitest';
import {
  BASE_SKILL,
  BOT_MANAGEMENT_SKILL,
  EMAIL_SKILL,
  PROGRAMMING_SKILL,
  RISK_MONITORING_SKILL,
  SYSTEM_SKILLS,
  TOOL_OWNER_OVERRIDES,
  TRADING_SKILL,
  buildToolOwnershipMap,
  inferDependsOn,
} from './skills.js';

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

  it('instructions describe slug-based skill addressing', () => {
    expect(BASE_SKILL.instructions).toContain('Skills are identified by their slug');
    expect(BASE_SKILL.instructions).toContain('system/trading');
    expect(BASE_SKILL.instructions).toContain('system/programming');
  });

  it('instructions describe automatic dependency inclusion with opt-out', () => {
    expect(BASE_SKILL.instructions).toContain('Dependencies are added automatically');
    expect(BASE_SKILL.instructions).toContain('includeDependencies');
  });

  it('instructions describe external skill support', () => {
    expect(BASE_SKILL.instructions).toContain('external skills');
    expect(BASE_SKILL.instructions).toContain('twostraws/swiftui-agent-skill');
    expect(BASE_SKILL.instructions).toContain('the platform installs them');
    expect(BASE_SKILL.instructions).toContain('file-management skill');
  });

  it('instructions mention add by slug and drop by slug', () => {
    expect(BASE_SKILL.instructions).toContain('add skills by slug');
    expect(BASE_SKILL.instructions).toContain('drop skills by slug');
  });

  it('instructions reference search_skills and external skills', () => {
    expect(BASE_SKILL.instructions).toContain('search_skills');
    expect(BASE_SKILL.instructions).toContain('external skills');
  });

  it('instructions no longer contain old skill management phrases', () => {
    // These phrases were replaced in the slug-based addressing update
    expect(BASE_SKILL.instructions).not.toContain('adopt platform skills');
    expect(BASE_SKILL.instructions).not.toContain('drop skills you no longer need');
    expect(BASE_SKILL.instructions).not.toContain('the standard skills.sh discovery flow');
    expect(BASE_SKILL.instructions).not.toContain('dependency skills you should also add');
    expect(BASE_SKILL.instructions).not.toContain('External skills are instruction bundles');
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

// ── buildToolOwnershipMap ───────────────────────────────────────────────────

describe('buildToolOwnershipMap', () => {
  const ownershipMap = buildToolOwnershipMap();

  it.each(['send_message', 'get_memory', 'list_skills', 'search_skills'])(
    'does not contain BASE_SKILL tool %s',
    (tool) => {
      expect(ownershipMap.has(tool)).toBe(false);
    },
  );

  it.each(['get_analytics', 'list_positions', 'get_price', 'adjust_risk_limits'])(
    'maps override tool %s to trading',
    (tool) => {
      expect(ownershipMap.get(tool)).toBe('trading');
    },
  );

  it('maps create_bot to bot-management', () => {
    expect(ownershipMap.get('create_bot')).toBe('bot-management');
  });

  it('maps execute_code to programming', () => {
    expect(ownershipMap.get('execute_code')).toBe('programming');
  });

  it('returns the same cached instance on repeated calls', () => {
    // buildToolOwnershipMap uses a module-level singleton; this asserts caching works.
    expect(buildToolOwnershipMap()).toBe(ownershipMap);
  });
});

// ── inferDependsOn ──────────────────────────────────────────────────────────

describe('inferDependsOn', () => {
  it('returns ["trading"] for bot-management (shared tools overridden to trading)', () => {
    const deps = inferDependsOn(
      BOT_MANAGEMENT_SKILL.requiredTools,
      BOT_MANAGEMENT_SKILL.id,
    );
    expect(deps).toEqual(['trading']);
  });

  it('returns [] for trading (all tools are base or self-owned)', () => {
    const deps = inferDependsOn(
      TRADING_SKILL.requiredTools,
      TRADING_SKILL.id,
    );
    expect(deps).toEqual([]);
  });

  it('returns ["trading"] for risk-monitoring (overridden tools owned by trading)', () => {
    const deps = inferDependsOn(
      RISK_MONITORING_SKILL.requiredTools,
      RISK_MONITORING_SKILL.id,
    );
    expect(deps).toEqual(['trading']);
  });

  it('returns [] for programming (execute_code is its own)', () => {
    const deps = inferDependsOn(
      PROGRAMMING_SKILL.requiredTools,
      PROGRAMMING_SKILL.id,
    );
    expect(deps).toEqual([]);
  });

  it('excludes BASE_SKILL tools from dependency inference', () => {
    // Synthetic list: send_message is a base tool, create_bot is bot-management.
    // Only create_bot should produce a dependency.
    const deps = inferDependsOn(['send_message', 'create_bot'], 'some-skill');
    expect(deps).toEqual(['bot-management']);
  });

  it('returns [] for empty requiredTools', () => {
    expect(inferDependsOn([], 'any-skill')).toEqual([]);
  });

  it('ignores tools not owned by any skill', () => {
    expect(inferDependsOn(['nonexistent_tool'], 'x')).toEqual([]);
  });

  it('returns a sorted array', () => {
    // Craft a requiredTools list that touches multiple foreign skills in reverse order.
    const deps = inferDependsOn(
      ['execute_code', 'create_bot', 'get_analytics'],
      'some-other-skill',
    );
    expect(deps).toEqual(['bot-management', 'programming', 'trading']);
    // Also verify sort invariant structurally.
    const sorted = [...deps].sort();
    expect(deps).toEqual(sorted);
  });
});

// ── TOOL_OWNER_OVERRIDES ────────────────────────────────────────────────────

describe('TOOL_OWNER_OVERRIDES', () => {
  it('contains only the expected override entries', () => {
    expect(Object.keys(TOOL_OWNER_OVERRIDES).sort()).toEqual([
      'adjust_risk_limits',
      'check_watches',
      'get_analytics',
      'get_price',
      'list_positions',
      'list_watches',
      'remove_watch',
      'resolve_watch',
      'watch_token',
    ]);
  });

  it('maps every override to trading', () => {
    for (const owner of Object.values(TOOL_OWNER_OVERRIDES)) {
      expect(owner).toBe('trading');
    }
  });

  it('every override tool exists in at least one SYSTEM_SKILLS skill', () => {
    const allSkillTools = new Set(SYSTEM_SKILLS.flatMap(s => s.requiredTools));
    for (const tool of Object.keys(TOOL_OWNER_OVERRIDES)) {
      expect(allSkillTools.has(tool), `override tool "${tool}" not found in any SYSTEM_SKILLS skill`).toBe(true);
    }
  });
});

// ── PROGRAMMING_SKILL — execute_shell ───────────────────────────────────────

describe('PROGRAMMING_SKILL', () => {
  it('has id "programming"', () => {
    expect(PROGRAMMING_SKILL.id).toBe('programming');
  });

  it('requiredTools includes execute_code', () => {
    expect(PROGRAMMING_SKILL.requiredTools).toContain('execute_code');
  });

  it('requiredTools includes execute_shell', () => {
    expect(PROGRAMMING_SKILL.requiredTools).toContain('execute_shell');
  });

  it('requiredTools contains exactly execute_code and execute_shell', () => {
    expect(PROGRAMMING_SKILL.requiredTools).toEqual(['execute_code', 'execute_shell']);
  });

  it('instructions mention execute_shell', () => {
    expect(PROGRAMMING_SKILL.instructions).toContain('execute_shell');
  });

  it('instructions mention permission level fallback to execute_code', () => {
    expect(PROGRAMMING_SKILL.instructions).toContain('permission level');
    expect(PROGRAMMING_SKILL.instructions).toContain('execute_code');
  });
});
