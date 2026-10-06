import { describe, it, expect } from 'vitest';
import {
  BASE_SKILL,
  EMAIL_SKILL,
  FILE_MANAGEMENT_SKILL,
  PROGRAMMING_SKILL,
  SKILL_PRESET_MAP,
  SYSTEM_SKILLS,
  TOOL_OWNER_OVERRIDES,
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
    expect(BASE_SKILL.instructions).toContain('system/programming');
  });

  it('instructions describe automatic dependency inclusion with opt-out', () => {
    expect(BASE_SKILL.instructions).toContain('Dependencies are added automatically');
    expect(BASE_SKILL.instructions).toContain('includeDependencies');
  });

  it('instructions describe external skill support via read_skill (Phase 4 progressive disclosure)', () => {
    expect(BASE_SKILL.instructions).toContain('external skills');
    expect(BASE_SKILL.instructions).toContain('twostraws/swiftui-agent-skill');
    expect(BASE_SKILL.instructions).toContain('read_skill');
    // file-management is no longer auto-added for external skills (T6).
    expect(BASE_SKILL.requiredTools).toContain('read_skill');
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
      'list_memory_keys', 'delete_memory', 'get_schema',
    ];
    for (const tool of corePreviousTools) {
      expect(BASE_SKILL.requiredTools).toContain(tool);
    }
  });

  it.each(['get_risk_limits', 'get_account_summary'])(
    'does not advertise trading-account tool %s',
    (toolName) => {
      expect(BASE_SKILL.requiredTools).not.toContain(toolName);
      expect(BASE_SKILL.instructions).not.toContain(toolName);
      expect(BASE_SKILL.description).not.toContain(toolName);
    },
  );
});

describe('EMAIL_SKILL', () => {
  it('has id email', () => {
    expect(EMAIL_SKILL.id).toBe('email');
  });

  it('requires send_email tool', () => {
    expect(EMAIL_SKILL.requiredTools).toContain('send_email');
  });
});

// Phase 4 (D21/EC-1): the built-in trading, bot-management and risk-monitoring
// skills were removed from the domain. Trading capability now comes from
// external skills.sh skills (`traderton/skills/crypto-*`), so there are no
// domain skill definitions to assert here.

describe('SYSTEM_SKILLS', () => {
  it('does not contain a skill with id gmail', () => {
    const gmailSkill = SYSTEM_SKILLS.find((s) => s.id === 'gmail');
    expect(gmailSkill).toBeUndefined();
  });

  it('does not contain the removed built-in trading skills', () => {
    const ids = SYSTEM_SKILLS.map((s) => s.id);
    expect(ids).not.toContain('trading');
    expect(ids).not.toContain('bot-management');
    expect(ids).not.toContain('risk-monitoring');
  });

  it('contains exactly the non-trading system skills', () => {
    expect(SYSTEM_SKILLS.map((s) => s.id).sort()).toEqual([
      'browser',
      'email',
      'file-management',
      'platform-docs',
      'programming',
      'web-access',
    ]);
  });

  // WP7 (D8): the `task-management` system skill was removed; its tools moved
  // into BASE_SKILL.
  it('does not contain the removed task-management skill', () => {
    expect(SYSTEM_SKILLS.map((s) => s.id)).not.toContain('task-management');
  });
});

// WP7 (D8): task and reminder tools now ship with the auto-injected base skill.
describe('BASE_SKILL — task and reminder tools (WP7 D8)', () => {
  const APPENDED_TOOLS = [
    'create_task',
    'list_tasks',
    'resolve_task',
    'complete_task',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  ];

  it.each(APPENDED_TOOLS)('requiredTools includes %s', (toolName) => {
    expect(BASE_SKILL.requiredTools).toContain(toolName);
  });

  it('has all seven appended task/reminder tools', () => {
    for (const tool of APPENDED_TOOLS) {
      expect(BASE_SKILL.requiredTools).toContain(tool);
    }
  });

  it('description mentions tasks and reminders', () => {
    expect(BASE_SKILL.description).toContain('tasks');
    expect(BASE_SKILL.description).toContain('reminders');
  });

  it('schedule_reminder instructions mention repeating and key', () => {
    expect(BASE_SKILL.instructions).toContain('schedule_reminder');
    expect(BASE_SKILL.instructions).toContain('repeatEveryMinutes');
    expect(BASE_SKILL.instructions).toContain('key');
  });

  it('instructions mention list_reminders and cancel_reminder', () => {
    expect(BASE_SKILL.instructions).toContain('list_reminders');
    expect(BASE_SKILL.instructions).toContain('cancel_reminder');
  });
});

// WP7 (D8): the personal-assistant preset no longer references task-management.
describe('SKILL_PRESET_MAP (WP7 D8)', () => {
  it('maps personal-assistant to web-access and email', () => {
    expect(SKILL_PRESET_MAP['personal-assistant']).toEqual(['web-access', 'email']);
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

  it('maps execute_code to programming', () => {
    expect(ownershipMap.get('execute_code')).toBe('programming');
  });

  it('maps write_file to file-management', () => {
    expect(ownershipMap.get('write_file')).toBe('file-management');
  });

  it('does not map any tool to a removed trading owner', () => {
    for (const owner of ownershipMap.values()) {
      expect(['trading', 'bot-management', 'risk-monitoring']).not.toContain(owner);
    }
  });

  it('returns the same cached instance on repeated calls', () => {
    // buildToolOwnershipMap uses a module-level singleton; this asserts caching works.
    expect(buildToolOwnershipMap()).toBe(ownershipMap);
  });
});

// ── inferDependsOn ──────────────────────────────────────────────────────────

describe('inferDependsOn', () => {
  it('returns [] for file-management (all tools are base or self-owned)', () => {
    const deps = inferDependsOn(
      FILE_MANAGEMENT_SKILL.requiredTools,
      FILE_MANAGEMENT_SKILL.id,
    );
    expect(deps).toEqual([]);
  });

  it('returns [] for programming (execute_code is its own)', () => {
    const deps = inferDependsOn(
      PROGRAMMING_SKILL.requiredTools,
      PROGRAMMING_SKILL.id,
    );
    expect(deps).toEqual([]);
  });

  it('excludes BASE_SKILL tools from dependency inference', () => {
    // Synthetic list: send_message is a base tool, execute_code is programming.
    // Only execute_code should produce a dependency.
    const deps = inferDependsOn(['send_message', 'execute_code'], 'some-skill');
    expect(deps).toEqual(['programming']);
  });

  it('returns [] when the only foreign tool is self-owned', () => {
    const deps = inferDependsOn(['execute_code'], 'programming');
    expect(deps).toEqual([]);
  });

  it('returns [] for empty requiredTools', () => {
    expect(inferDependsOn([], 'any-skill')).toEqual([]);
  });

  it('ignores tools not owned by any skill', () => {
    expect(inferDependsOn(['nonexistent_tool'], 'x')).toEqual([]);
  });

  // WP7 (D8): schedule_reminder is now a base-skill tool, so it is excluded
  // from dependency inference (base tools are universal, not "owned").
  it('returns [] for schedule_reminder (now a base tool)', () => {
    expect(inferDependsOn(['schedule_reminder'], 'x')).toEqual([]);
  });

  it('returns a sorted array across multiple foreign skills', () => {
    // Craft a requiredTools list that touches multiple foreign skills in reverse order.
    const deps = inferDependsOn(
      ['write_file', 'execute_code'],
      'some-other-skill',
    );
    expect(deps).toEqual(['file-management', 'programming']);
    // Also verify sort invariant structurally.
    const sorted = [...deps].sort();
    expect(deps).toEqual(sorted);
  });
});

// ── TOOL_OWNER_OVERRIDES ────────────────────────────────────────────────────

describe('TOOL_OWNER_OVERRIDES', () => {
  // Phase 4 (D21/EC-3): every prior override mapped a trading tool to the
  // removed `trading` built-in skill. With those skills gone there are no
  // cross-skill ownership overrides among the remaining system skills.
  it('is empty', () => {
    expect(Object.keys(TOOL_OWNER_OVERRIDES)).toEqual([]);
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
