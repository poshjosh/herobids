import { describe, it, expect } from 'vitest';
import {
  CHILD_AGENT_MANAGEMENT_SKILL,
  BASE_SKILL,
  EMAIL_SKILL,
  FILE_MANAGEMENT_SKILL,
  isUserOnlySkill,
  LONG_RUNNING_TASK_SKILL,
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
    expect(BASE_SKILL.instructions).toContain('traderton/skills/crypto-trading');
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
      'child-agent-management',
      'email',
      'file-management',
      'long-running-task',
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

// ── LONG_RUNNING_TASK_SKILL — continuity across runs ────────────────────────

/** Text of one numbered EACH RUN step of LONG_RUNNING_TASK_SKILL, up to the next step or the RULES section. */
function longRunningStep(step: number): string {
  const { instructions } = LONG_RUNNING_TASK_SKILL;
  const eachRun = instructions.indexOf('\nEACH RUN\n');
  const rules = instructions.indexOf('\nRULES\n', eachRun);
  const start = instructions.indexOf(`\n${step}. `, eachRun);
  if (eachRun === -1 || rules === -1 || start === -1 || start > rules) {
    throw new Error(`EACH RUN step ${step} not found`);
  }
  const nextStep = instructions.indexOf(`\n${step + 1}. `, start + 1);
  return instructions.slice(start, nextStep !== -1 && nextStep < rules ? nextStep : rules);
}

describe('LONG_RUNNING_TASK_SKILL', () => {
  it('has slug "system/long-running-task" and is a registered system skill', () => {
    expect(LONG_RUNNING_TASK_SKILL.slug).toBe('system/long-running-task');
    expect(SYSTEM_SKILLS).toContain(LONG_RUNNING_TASK_SKILL);
  });

  it('depends on file-management through tool ownership', () => {
    expect(inferDependsOn(LONG_RUNNING_TASK_SKILL.requiredTools, LONG_RUNNING_TASK_SKILL.id)).toEqual(['file-management']);
  });

  it.each([
    'get_memory',
    'set_memory',
    'list_memory_keys',
    'create_task',
    'list_tasks',
    'complete_task',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  ])('instructions use the base tool %s, which BASE_SKILL provides', (toolName) => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain(toolName);
    expect(BASE_SKILL.requiredTools).toContain(toolName);
  });

  it('has two levels of work, the goal and its units, and no cycles', () => {
    const { instructions } = LONG_RUNNING_TASK_SKILL;
    expect(instructions).toContain('- Goal: the whole long-running task.');
    expect(instructions).toContain('- Unit: one portion of the goal');
    expect(instructions).not.toMatch(/cycle/i);
  });

  it('speaks of runs, not ticks, apart from defining a run', () => {
    const { instructions } = LONG_RUNNING_TASK_SKILL;
    expect(instructions).toContain('- Run: one tick/session');
    expect(instructions.replace('- Run: one tick/session', '')).not.toMatch(/tick/i);
  });

  it('keeps durable progress in tasks and memory, not workspace files', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('ltt/<campaign>/index');
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('Workspace files are NOT durable');
  });

  it('saves the goal, whether it is ongoing, its end time, the run budget, where results are kept and the phase in the index', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('{ goal, ongoing, endsAt, runBudget, storage, phase, lastSummary, updatedAt }');
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('`phase`: `active`, `ending` or `ended`.');
  });

  it('lets the agent decide the run budget, saves it, and does units up to it across the whole run', () => {
    const { instructions } = LONG_RUNNING_TASK_SKILL;
    expect(instructions).toContain('`runBudget`: how much to do in one run. Decide it from the goal');
    expect(instructions).toContain('It covers the whole run.');
    expect(longRunningStep(5)).toContain('Do units up to `runBudget`');
    expect(instructions).not.toMatch(/up to \d+ units/);
  });

  it('keeps campaign names free of hyphens, so one campaign\'s key prefix cannot match another campaign\'s keys', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('(lowercase letters and digits only)');
  });

  it('finds the campaign after a restart from the wake message, task titles or the index goal', () => {
    const orient = longRunningStep(1);
    expect(orient).toContain('look for it in the message that woke you and in the task titles');
    expect(orient).toContain('read the `ltt/<name>/index` keys and use the one whose `goal` is this goal');
  });

  it('counts only this goal\'s tasks as its pending units', () => {
    expect(longRunningStep(1)).toContain('Only tasks titled `[<campaign>]` are this goal\'s pending units; ignore the rest.');
  });

  it('creates the units before writing the index, so an interrupted plan cannot look like a finished goal', () => {
    const plan = longRunningStep(2);
    expect(plan.indexOf('create one task per unit')).toBeLessThan(plan.indexOf('then write the index'));
    expect(plan).toContain('create only the units that are not already in the task list');
  });

  it('schedules a fallback continuation before any work, which the last step replaces', () => {
    expect(longRunningStep(3)).toContain('Unless the phase is `ended`, schedule the continuation now');
    expect(longRunningStep(3)).toContain('Step 7 replaces it.');
  });

  it('ends the goal when its work is done, its end time has passed, or the user asks to stop', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('It ends when its work is done, when its end time has passed, or when the user asks to stop.');
    expect(longRunningStep(4)).toContain('If the phase is `active` and `endsAt` has passed or the user has asked to stop, set the phase to `ending`.');
    expect(longRunningStep(6)).toContain('If none are pending and `ongoing` is false, the goal\'s work is done: set the phase to `ending`');
  });

  it('finishes the work the goal requires at its end before setting ended, continuing it in later runs if needed', () => {
    const goalEnd = longRunningStep(4);
    expect(goalEnd).toContain('If the phase is `ending`, start no new units: do only the work the goal requires at its end');
    expect(goalEnd).toContain('When that work is finished, set the phase to `ended`; if it is not, go to step 7 and continue it in the next run.');
    expect(goalEnd.indexOf('set the phase to `ended`')).toBeLessThan(goalEnd.indexOf('cancel_reminder'));
  });

  it('leaves the pending units of an ending or ended goal alone', () => {
    expect(longRunningStep(4)).toContain('Pending units stay pending once the phase is `ending` or `ended`; ignore them.');
  });

  it('cancels reminders only when the goal has ended (one-shot reminders are consumed when they fire)', () => {
    const goalEnd = longRunningStep(4);
    expect(goalEnd).toContain('cancel each reminder whose key starts with `ltt-<campaign>-`');
    expect(LONG_RUNNING_TASK_SKILL.instructions.replace(goalEnd, '')).not.toContain('cancel_reminder');
  });

  it('gives the exact continuation key convention, under the goal\'s reminder prefix', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('key: "ltt-<campaign>-continue"');
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('give every reminder you schedule for this goal a key that starts with `ltt-<campaign>-`.');
  });

  it('saves a reason before closing a unit that cannot be done, so later runs do not retry it forever', () => {
    expect(longRunningStep(5)).toContain('If a unit cannot be done, save a one-line reason with the goal\'s results, then complete its task');
  });

  it('stops doing units when some are still pending after the run budget is used', () => {
    expect(longRunningStep(6)).toContain('If units are still pending, go to step 7.');
  });

  it('does not update the index or schedule a continuation once the goal has ended', () => {
    const lastStep = longRunningStep(7);
    expect(lastStep).toContain('Unless the phase is `ended`, update `lastSummary` and `updatedAt` in the index, and schedule the continuation');
    expect(lastStep).toContain('while the phase is `active`, never later than `endsAt`');
  });

  it('lists finish_run as a required tool', () => {
    expect(LONG_RUNNING_TASK_SKILL.requiredTools).toContain('finish_run');
  });

  it('tells the agent to end every run with finish_run and which status to use', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).toContain('Call `finish_run` to end each run.');
    expect(longRunningStep(7)).toContain('then call `finish_run`.');
    expect(longRunningStep(7)).toContain('Use `waiting` while the goal has not ended, `complete` once it has ended, and `blocked` if you cannot continue.');
  });

  it('deals only with continuity between runs: no reports, user messages or rules about the quality of the work', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).not.toMatch(/report|send_message|publish_artifact|verified|evidence/i);
  });

  it('says nothing about skills that use it', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).not.toMatch(/\bhosting\b|\bjobs?\b/i);
  });

  it('keeps depending only on file-management after adding finish_run', () => {
    expect(inferDependsOn(LONG_RUNNING_TASK_SKILL.requiredTools, LONG_RUNNING_TASK_SKILL.id)).toEqual(['file-management']);
  });

  it('owns finish_run in the tool ownership map', () => {
    expect(buildToolOwnershipMap().get('finish_run')).toBe(LONG_RUNNING_TASK_SKILL.id);
  });

  it('is domain-agnostic', () => {
    expect(LONG_RUNNING_TASK_SKILL.instructions).not.toMatch(/farm|hofnachfolge|probe|sourdough/i);
  });
});

describe('BASE_SKILL — long-running task pointer', () => {
  it('tells the agent to add system/long-running-task for goals that span ticks', () => {
    expect(BASE_SKILL.instructions).toContain('system/long-running-task');
    expect(BASE_SKILL.instructions).toContain('cannot be finished in one tick');
  });

  it('does not bake the long-running protocol into the base prompt', () => {
    expect(BASE_SKILL.instructions).not.toContain('ltt/<campaign>');
  });
});

describe('child-agent-management skill', () => {
  it('lists exactly the seven child-management tools', () => {
    expect(CHILD_AGENT_MANAGEMENT_SKILL.requiredTools.slice().sort()).toEqual([
      'create_child_agent',
      'delete_child_agent',
      'get_child_agent_status',
      'list_child_agents',
      'message_child_agent',
      'pause_child_agent',
      'stop_child_agent',
    ]);
  });

  it('is a system skill, so it is seeded with the others', () => {
    expect(SYSTEM_SKILLS).toContain(CHILD_AGENT_MANAGEMENT_SKILL);
    expect(CHILD_AGENT_MANAGEMENT_SKILL.slug).toBe('system/child-agent-management');
  });

  it('is user-only by id and by system slug, and no other skill is', () => {
    expect(isUserOnlySkill('child-agent-management')).toBe(true);
    expect(isUserOnlySkill('system/child-agent-management')).toBe(true);
    expect(isUserOnlySkill('browser')).toBe(false);
    expect(isUserOnlySkill('system/browser')).toBe(false);
    expect(isUserOnlySkill('base')).toBe(false);
  });

  it('is not in the base skill, so an agent without it cannot see the child tools', () => {
    for (const tool of CHILD_AGENT_MANAGEMENT_SKILL.requiredTools) {
      expect(BASE_SKILL.requiredTools).not.toContain(tool);
    }
    expect(BASE_SKILL.requiredTools).toContain('message_peer_agent');
  });
});

