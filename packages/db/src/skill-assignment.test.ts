import { describe, it, expect, vi } from 'vitest';
import { resolveSkillIdsBySlugOrId } from './skill-assignment.js';
import type { Database } from './index.js';

// ── Mock helpers ────────────────────────────────────────────────────────────

/**
 * Builds a mock DB whose `.select().from().where()` chain resolves to the
 * given rows.  Mirrors the Drizzle fluent query pattern used by
 * `resolveSkillIdsBySlugOrId`.
 */
function buildMockDb(rows: Array<{ id: string; slug: string | null }>): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as Database;
}

// ── resolveSkillIdsBySlugOrId ───────────────────────────────────────────────

describe('resolveSkillIdsBySlugOrId', () => {
  it('returns empty map for empty refs array', async () => {
    const db = buildMockDb([]);
    const result = await resolveSkillIdsBySlugOrId(db, []);
    expect(result).toEqual(new Map());
    // Should short-circuit — no DB call
    expect(db.select).not.toHaveBeenCalled();
  });

  it('resolves a single slug match', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/trading' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['system/trading']);

    expect(result).toEqual(new Map([
      ['system/trading', 'skill-uuid-1'],
    ]));
  });

  it('resolves a single ID match', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/trading' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['skill-uuid-1']);

    expect(result).toEqual(new Map([
      ['skill-uuid-1', 'skill-uuid-1'],
    ]));
  });

  it('resolves mixed slugs and IDs in one call', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/trading' },
      { id: 'skill-uuid-2', slug: 'system/assistant' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/trading',
      'skill-uuid-2',
    ]);

    expect(result).toEqual(new Map([
      ['system/trading', 'skill-uuid-1'],
      ['skill-uuid-2', 'skill-uuid-2'],
    ]));
  });

  it('omits refs that match nothing', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/trading' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/trading',
      'nonexistent-ref',
    ]);

    expect(result).toEqual(new Map([
      ['system/trading', 'skill-uuid-1'],
    ]));
    expect(result.has('nonexistent-ref')).toBe(false);
  });

  it('deduplicates refs so each appears once in the result', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/trading' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/trading',
      'system/trading',
      'system/trading',
    ]);

    expect(result).toEqual(new Map([
      ['system/trading', 'skill-uuid-1'],
    ]));
    expect(result.size).toBe(1);
  });

  it('returns empty map when no refs match anything', async () => {
    const db = buildMockDb([]);
    const result = await resolveSkillIdsBySlugOrId(db, ['ghost-1', 'ghost-2']);
    expect(result.size).toBe(0);
  });

  it('resolves via ID only when row has null slug', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: null },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['skill-uuid-1']);

    expect(result).toEqual(new Map([
      ['skill-uuid-1', 'skill-uuid-1'],
    ]));
  });

  it('slug match takes precedence over ID match when a ref matches both', async () => {
    // Scenario: the ref string "ambiguous-ref" is the slug of skill-A
    // AND the ID of skill-B.  The slug match (skill-A) should win.
    const db = buildMockDb([
      { id: 'skill-A-id', slug: 'ambiguous-ref' },   // slug matches the ref
      { id: 'ambiguous-ref', slug: 'other/slug' },    // id matches the ref
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['ambiguous-ref']);

    // Slug match wins: key = 'ambiguous-ref', value = skill-A's ID
    expect(result.get('ambiguous-ref')).toBe('skill-A-id');
    expect(result.size).toBe(1);
  });
});
