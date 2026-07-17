import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_CATEGORY_LABELS, getToolCatalogEntry, KNOWN_AGENT_TOOL_NAMES } from './tools.js';

describe('TOOL_CATALOG', () => {
  it('has exactly 48 entries, matching KNOWN_AGENT_TOOL_NAMES length', () => {
    const catalogKeys = Object.keys(TOOL_CATALOG);
    expect(catalogKeys).toHaveLength(48);
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
      'Submit a trade decision for a specific instrument. Evaluated by risk gate and executed if approved.',
    );
  });

  it('returns undefined for a nonexistent tool', () => {
    const entry = getToolCatalogEntry('nonexistent');
    expect(entry).toBeUndefined();
  });
});
