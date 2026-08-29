import { describe, it, expect } from 'vitest';
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
      'Search for skills by keyword across the platform catalog and external skills discoverable through skills.sh.',
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
