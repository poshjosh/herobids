import { describe, it, expect } from 'vitest';
import type { ToolContext } from './tools.js';
import {
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  getToolCatalogEntry,
  KNOWN_AGENT_TOOL_NAMES,
  isKnownAgentToolName,
  findUnknownSkillTools,
} from './tools.js';
import { BASE_SKILL } from './skills.js';

describe('TOOL_CATALOG', () => {
  it('has exactly KNOWN_AGENT_TOOL_NAMES length entries', () => {
    const catalogKeys = Object.keys(TOOL_CATALOG);
    expect(catalogKeys).toHaveLength(KNOWN_AGENT_TOOL_NAMES.length);
  });

  it('has every key in KNOWN_AGENT_TOOL_NAMES and vice versa', () => {
    const catalogKeys = new Set(Object.keys(TOOL_CATALOG));
    const knownSet = new Set(KNOWN_AGENT_TOOL_NAMES);

    // Every catalog key is known
    for (const key of catalogKeys) {
      expect(knownSet.has(key)).toBe(true);
    }

    // Every known name is in the catalog
    for (const name of knownSet) {
      expect(catalogKeys.has(name)).toBe(true);
    }
  });
});

describe('TOOL_CATEGORY_LABELS', () => {
  it('has exactly 12 entries (one per ToolCategory variant used by the catalog)', () => {
    expect(Object.keys(TOOL_CATEGORY_LABELS)).toHaveLength(12);
  });

  it('has a label for every category used by a tool in TOOL_CATALOG', () => {
    const usedCategories = new Set(Object.values(TOOL_CATALOG).map((e) => e.category));
    const labeledCategories = new Set(Object.keys(TOOL_CATEGORY_LABELS));
    for (const cat of usedCategories) {
      expect(labeledCategories.has(cat)).toBe(true);
    }
  });
});

describe('getToolCatalogEntry()', () => {
  it('returns the correct entry for submit_decision', () => {
    const entry = getToolCatalogEntry('submit_decision');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('execute-trade');
    expect(entry!.description).toBe(
      'Submit a trade decision for a specific instrument. In direct mode, accepted decisions execute immediately. In approval_required mode, the decision is recorded and sent to the user for approval — no trade executes until the user responds with /yes <code> or /no <code>.',
    );
  });

  it('returns undefined for a nonexistent tool', () => {
    const entry = getToolCatalogEntry('nonexistent');
    expect(entry).toBeUndefined();
  });
});

// ── Skill tool names in KNOWN_AGENT_TOOL_NAMES ──────────────────────────────

describe('KNOWN_AGENT_TOOL_NAMES — skill tools', () => {
  it.each(['add_skills', 'list_skills', 'remove_skills', 'search_skills'])(
    'includes %s',
    (toolName) => {
      expect(KNOWN_AGENT_TOOL_NAMES).toContain(toolName);
    },
  );

  it('recognises skill tool names via isKnownAgentToolName()', () => {
    expect(isKnownAgentToolName('add_skills')).toBe(true);
    expect(isKnownAgentToolName('list_skills')).toBe(true);
    expect(isKnownAgentToolName('remove_skills')).toBe(true);
    expect(isKnownAgentToolName('search_skills')).toBe(true);
  });

  it('rejects an unknown tool name via isKnownAgentToolName()', () => {
    expect(isKnownAgentToolName('fly_to_moon')).toBe(false);
  });
});

// ── TOOL_CATALOG entries for skill tools ────────────────────────────────────

describe('TOOL_CATALOG — skill tool entries', () => {
  it('list_skills has category read-database', () => {
    const entry = getToolCatalogEntry('list_skills');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('read-database');
  });

  it('add_skills has category write-database', () => {
    const entry = getToolCatalogEntry('add_skills');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('write-database');
  });

  it('remove_skills has category write-database', () => {
    const entry = getToolCatalogEntry('remove_skills');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('write-database');
  });

  it('search_skills has category read-database', () => {
    const entry = getToolCatalogEntry('search_skills');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('read-database');
  });

  it('search_skills has the correct description', () => {
    const entry = getToolCatalogEntry('search_skills');
    expect(entry).toBeDefined();
    expect(entry!.description).toBe(
      'Search for skills by keyword across the platform catalog and the external skill registry.',
    );
  });

  it('each skill tool has a non-empty description', () => {
    for (const name of ['add_skills', 'list_skills', 'remove_skills', 'search_skills']) {
      const entry = getToolCatalogEntry(name);
      expect(entry).toBeDefined();
      expect(entry!.description.length).toBeGreaterThan(0);
    }
  });
});

// ── KNOWN_AGENT_TOOL_NAMES — alphabetical ordering around search_skills ─────

describe('KNOWN_AGENT_TOOL_NAMES — alphabetical ordering', () => {
  it('maintains search_app_docs < search_skills < search_tokens order', () => {
    const names = KNOWN_AGENT_TOOL_NAMES as readonly string[];
    const idxAppDocs = names.indexOf('search_app_docs');
    const idxSkills = names.indexOf('search_skills');
    const idxTokens = names.indexOf('search_tokens');

    expect(idxAppDocs).toBeGreaterThanOrEqual(0);
    expect(idxSkills).toBeGreaterThanOrEqual(0);
    expect(idxTokens).toBeGreaterThanOrEqual(0);
    expect(idxAppDocs).toBeLessThan(idxSkills);
    expect(idxSkills).toBeLessThan(idxTokens);
  });
});

// ── KNOWN_AGENT_TOOL_NAMES — execute_shell ──────────────────────────────────

describe('KNOWN_AGENT_TOOL_NAMES — execute_shell', () => {
  it('includes execute_shell', () => {
    expect(KNOWN_AGENT_TOOL_NAMES).toContain('execute_shell');
  });

  it('recognises execute_shell via isKnownAgentToolName()', () => {
    expect(isKnownAgentToolName('execute_shell')).toBe(true);
  });

  it('maintains execute_code < execute_shell alphabetical order', () => {
    const names = KNOWN_AGENT_TOOL_NAMES as readonly string[];
    const idxCode = names.indexOf('execute_code');
    const idxShell = names.indexOf('execute_shell');
    expect(idxCode).toBeGreaterThanOrEqual(0);
    expect(idxShell).toBeGreaterThanOrEqual(0);
    expect(idxCode).toBeLessThan(idxShell);
  });
});

// ── TOOL_CATALOG — execute_shell entry ──────────────────────────────────────

describe('TOOL_CATALOG — execute_shell entry', () => {
  it('has an entry for execute_shell', () => {
    const entry = getToolCatalogEntry('execute_shell');
    expect(entry).toBeDefined();
  });

  it('execute_shell has category execute-filesystem', () => {
    const entry = getToolCatalogEntry('execute_shell');
    expect(entry!.category).toBe('execute-filesystem');
  });

  it('execute_shell has a non-empty description', () => {
    const entry = getToolCatalogEntry('execute_shell');
    expect(entry!.description.length).toBeGreaterThan(0);
  });

  it('execute_shell description mentions permission levels', () => {
    const entry = getToolCatalogEntry('execute_shell');
    expect(entry!.description).toContain('permission level');
  });

  it('execute_shell shares execute-filesystem category with execute_code', () => {
    const shellEntry = getToolCatalogEntry('execute_shell');
    const codeEntry = getToolCatalogEntry('execute_code');
    expect(shellEntry!.category).toBe(codeEntry!.category);
  });
});

// ── findUnknownSkillTools ───────────────────────────────────────────────────

describe('findUnknownSkillTools()', () => {
  it('returns [] for BASE_SKILL.requiredTools (all known)', () => {
    expect(findUnknownSkillTools(BASE_SKILL.requiredTools)).toEqual([]);
  });

  it('returns [] for an empty input array', () => {
    expect(findUnknownSkillTools([])).toEqual([]);
  });

  it('returns unknown tools sorted and deduplicated', () => {
    const result = findUnknownSkillTools(['send_message', 'teleport', 'teleport', 'antigravity']);
    expect(result).toEqual(['antigravity', 'teleport']);
  });

  it('returns only the unknown tools when mixed with known ones', () => {
    const result = findUnknownSkillTools(['list_skills', 'unknown_tool', 'add_skills']);
    expect(result).toEqual(['unknown_tool']);
  });

  it('does not include search_skills as unknown', () => {
    const result = findUnknownSkillTools(['search_skills']);
    expect(result).toEqual([]);
  });
});

// ── skillOps interface on ToolContext ────────────────────────────────────────

describe('ToolContext.skillOps — type-level and shape tests', () => {
  /**
   * Build a mock skillOps that satisfies the ToolContext['skillOps'] type.
   * If it compiles, the interface contract is met; the runtime assertions
   * below verify the shapes are what consumers expect.
   */
  const mockSkillOps: NonNullable<ToolContext['skillOps']> = {
    listAssigned: async () => [
      { id: 'sk-1', slug: 'skill-a', name: 'Skill A', description: 'Does A things', dependsOn: ['sk-0'] },
    ],
    listAvailable: async () => [
      { id: 'sk-2', slug: 'skill-b', name: 'Skill B', description: 'Does B things', dependsOn: [] },
    ],
    search: async (_query: string, _limit?: number) => [
      {
        id: 'sk-3',
        slug: 'skill-c',
        name: 'Skill C',
        description: 'Does C things',
        isAssigned: false,
        dependsOn: ['sk-1', 'sk-2'],
      },
    ],
  };

  // ── listAssigned ────────────────────────────────────────────────────────

  it('listAssigned() returns items with dependsOn: string[]', async () => {
    const items = await mockSkillOps.listAssigned();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toHaveProperty('dependsOn');
    expect(Array.isArray(item.dependsOn)).toBe(true);
    expect(item.dependsOn).toEqual(['sk-0']);
  });

  it('listAssigned() returns items with id, name, and description', async () => {
    const items = await mockSkillOps.listAssigned();
    const item = items[0]!;
    expect(item.id).toBe('sk-1');
    expect(item.name).toBe('Skill A');
    expect(item.description).toBe('Does A things');
  });

  // ── listAvailable ──────────────────────────────────────────────────────

  it('listAvailable() returns items with dependsOn: string[]', async () => {
    const items = await mockSkillOps.listAvailable();
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toHaveProperty('dependsOn');
    expect(Array.isArray(item.dependsOn)).toBe(true);
    expect(item.dependsOn).toEqual([]);
  });

  it('listAvailable() returns items with id, name, and description', async () => {
    const items = await mockSkillOps.listAvailable();
    const item = items[0]!;
    expect(item.id).toBe('sk-2');
    expect(item.name).toBe('Skill B');
    expect(item.description).toBe('Does B things');
  });

  // ── search ─────────────────────────────────────────────────────────────

  it('search() exists and accepts (query, limit?) parameters', async () => {
    // Call with both args
    const withLimit = await mockSkillOps.search('crypto', 5);
    expect(withLimit).toHaveLength(1);

    // Call with only the required arg
    const withoutLimit = await mockSkillOps.search('crypto');
    expect(withoutLimit).toHaveLength(1);
  });

  it('search() return items include isAssigned and dependsOn', async () => {
    const items = await mockSkillOps.search('anything');
    const item = items[0]!;
    expect(item).toHaveProperty('isAssigned');
    expect(typeof item.isAssigned).toBe('boolean');
    expect(item.isAssigned).toBe(false);

    expect(item).toHaveProperty('dependsOn');
    expect(Array.isArray(item.dependsOn)).toBe(true);
    expect(item.dependsOn).toEqual(['sk-1', 'sk-2']);
  });

  it('search() returns items with id, name, and description', async () => {
    const items = await mockSkillOps.search('anything');
    const item = items[0]!;
    expect(item.id).toBe('sk-3');
    expect(item.name).toBe('Skill C');
    expect(item.description).toBe('Does C things');
  });

  // ── edge: empty results ────────────────────────────────────────────────

  it('handles empty arrays from all skillOps methods', async () => {
    const emptyOps: NonNullable<ToolContext['skillOps']> = {
      listAssigned: async () => [],
      listAvailable: async () => [],
      search: async () => [],
    };
    expect(await emptyOps.listAssigned()).toEqual([]);
    expect(await emptyOps.listAvailable()).toEqual([]);
    expect(await emptyOps.search('q')).toEqual([]);
  });

  // ── edge: multiple dependsOn entries ───────────────────────────────────

  it('supports multiple dependsOn entries in listAssigned and listAvailable', async () => {
    const ops: NonNullable<ToolContext['skillOps']> = {
      listAssigned: async () => [
        { id: 'sk-x', slug: 'x', name: 'X', description: 'X desc', dependsOn: ['sk-a', 'sk-b', 'sk-c'] },
      ],
      listAvailable: async () => [
        { id: 'sk-y', slug: 'y', name: 'Y', description: 'Y desc', dependsOn: ['sk-d'] },
      ],
      search: async () => [],
    };

    const assigned = await ops.listAssigned();
    expect(assigned[0]!.dependsOn).toEqual(['sk-a', 'sk-b', 'sk-c']);

    const available = await ops.listAvailable();
    expect(available[0]!.dependsOn).toEqual(['sk-d']);
  });
});
