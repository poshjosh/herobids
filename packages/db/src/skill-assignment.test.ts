import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { resolveSkillIdsBySlugOrId, syncAgentSkillAssignmentsInTx } from './skill-assignment.js';
import { upsertExternalSkill } from './external-skill-catalog.js';
import * as schema from './schema/index.js';
import { createScratchDatabase, localDatabaseUrl, type ScratchDatabase } from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';
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
      { id: 'skill-uuid-1', slug: 'system/programming' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['system/programming']);

    expect(result).toEqual(new Map([
      ['system/programming', 'skill-uuid-1'],
    ]));
  });

  it('resolves a single ID match', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/programming' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, ['skill-uuid-1']);

    expect(result).toEqual(new Map([
      ['skill-uuid-1', 'skill-uuid-1'],
    ]));
  });

  it('resolves mixed slugs and IDs in one call', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/programming' },
      { id: 'skill-uuid-2', slug: 'system/web-access' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/programming',
      'skill-uuid-2',
    ]);

    expect(result).toEqual(new Map([
      ['system/programming', 'skill-uuid-1'],
      ['skill-uuid-2', 'skill-uuid-2'],
    ]));
  });

  it('omits refs that match nothing', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/programming' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/programming',
      'nonexistent-ref',
    ]);

    expect(result).toEqual(new Map([
      ['system/programming', 'skill-uuid-1'],
    ]));
    expect(result.has('nonexistent-ref')).toBe(false);
  });

  it('deduplicates refs so each appears once in the result', async () => {
    const db = buildMockDb([
      { id: 'skill-uuid-1', slug: 'system/programming' },
    ]);

    const result = await resolveSkillIdsBySlugOrId(db, [
      'system/programming',
      'system/programming',
      'system/programming',
    ]);

    expect(result).toEqual(new Map([
      ['system/programming', 'skill-uuid-1'],
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

// ── Bug condition exploration: provenance of existing assignments (Property 2) ──

const BASE_URL = localDatabaseUrl();
const T0 = new Date('2026-10-30T10:00:00.000Z');

describe.skipIf(!BASE_URL)('syncAgentSkillAssignmentsInTx provenance (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let db: Database;
  let existingSkill: { skillId: string; skillRevisionId: string };
  let newSkill: { skillId: string; skillRevisionId: string };
  let existingSkillV2: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, '9999_all.sql');
    const { host, port, user, pass, database } = scratch.sql.options;
    pool = postgres({ host: host[0], port: port[0], user, pass: pass ?? undefined, database }, { max: 1 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    await truncate(scratch.sql, 'agent_skills', 'skill_usage_events', 'skills', 'agents', 'users');
    await scratch.sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-U', 'owner', 'Owner', 'owner@example.test'),
      ('user-V', 'other', 'Other', 'other@example.test')`;
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
      ('agent-1', 'user-U', 'Momo', 'p', 'active')`;
    existingSkill = await upsertExternalSkill(db, { sourceRef: 'o/r/existing', name: 'existing', description: '' });
    newSkill = await upsertExternalSkill(db, { sourceRef: 'o/r/added', name: 'added', description: '' });
    existingSkillV2 = `${existingSkill.skillId}:external:2`;
    await scratch.sql`INSERT INTO skill_revisions (id, skill_id, version, name, description, instructions)
      VALUES (${existingSkillV2}, ${existingSkill.skillId}, 2, 'existing', '', '')`;
    await scratch.sql`INSERT INTO agent_skills
      (agent_id, skill_id, skill_revision_id, order_index, assigned_at, assigned_by_user_id, assignment_source)
      VALUES ('agent-1', ${existingSkill.skillId}, ${existingSkill.skillRevisionId}, 5, ${T0}, 'user-U', 'user_select')`;
  });

  async function readAssignments() {
    const rows = await scratch.sql`SELECT skill_id, skill_revision_id, order_index, assigned_at,
      assigned_by_user_id, assignment_source FROM agent_skills WHERE agent_id = 'agent-1'`;
    return new Map(rows.map((row) => [row['skill_id'] as string, row] as const));
  }

  it('keeps assignment_source, assigned_at and assigned_by_user_id of an already-assigned skill', async () => {
    await db.transaction((tx) => syncAgentSkillAssignmentsInTx(
      tx,
      'agent-1',
      'user-V',
      [
        { skillId: existingSkill.skillId, skillRevisionId: existingSkill.skillRevisionId },
        { skillId: newSkill.skillId, skillRevisionId: newSkill.skillRevisionId },
      ],
      'agent_self',
    ));

    const old = (await readAssignments()).get(existingSkill.skillId)!;
    expect(old['assignment_source']).toBe('user_select');
    expect((old['assigned_at'] as Date).toISOString()).toBe(T0.toISOString());
    expect(old['assigned_by_user_id']).toBe('user-U');
  });

  it('applies the passed source only to the newly added skill', async () => {
    await db.transaction((tx) => syncAgentSkillAssignmentsInTx(
      tx,
      'agent-1',
      'user-V',
      [
        { skillId: existingSkill.skillId, skillRevisionId: existingSkill.skillRevisionId },
        { skillId: newSkill.skillId, skillRevisionId: newSkill.skillRevisionId },
      ],
      'agent_self',
    ));

    const added = (await readAssignments()).get(newSkill.skillId)!;
    expect(added['assignment_source']).toBe('agent_self');
    expect(added['assigned_by_user_id']).toBe('user-V');
  });

  it('still updates order_index and skill_revision_id of an already-assigned skill', async () => {
    await db.transaction((tx) => syncAgentSkillAssignmentsInTx(
      tx,
      'agent-1',
      'user-V',
      [
        { skillId: newSkill.skillId, skillRevisionId: newSkill.skillRevisionId },
        { skillId: existingSkill.skillId, skillRevisionId: existingSkillV2 },
      ],
      'agent_self',
    ));

    const old = (await readAssignments()).get(existingSkill.skillId)!;
    expect(old['order_index']).toBe(1);
    expect(old['skill_revision_id']).toBe(existingSkillV2);
  });
});

// ── Preservation (Property 4): syncs without a provenance conflict behave as before ──
// Provenance of already-assigned rows is deliberately NOT asserted here: that is the bug
// condition covered by the exploration tests above.

describe.skipIf(!BASE_URL)('syncAgentSkillAssignmentsInTx without provenance conflict (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let db: Database;
  let a: { skillId: string; skillRevisionId: string };
  let b: { skillId: string; skillRevisionId: string };
  let c: { skillId: string; skillRevisionId: string };
  let aV2: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, '9999_all.sql');
    const { host, port, user, pass, database } = scratch.sql.options;
    pool = postgres({ host: host[0], port: port[0], user, pass: pass ?? undefined, database }, { max: 1 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    await truncate(scratch.sql, 'agent_skills', 'skill_usage_events', 'skills', 'agents', 'users');
    await scratch.sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-U', 'owner', 'Owner', 'owner@example.test')`;
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
      ('agent-1', 'user-U', 'Momo', 'p', 'active')`;
    a = await upsertExternalSkill(db, { sourceRef: 'o/r/a', name: 'a', description: '' });
    b = await upsertExternalSkill(db, { sourceRef: 'o/r/b', name: 'b', description: '' });
    c = await upsertExternalSkill(db, { sourceRef: 'o/r/c', name: 'c', description: '' });
    aV2 = `${a.skillId}:external:2`;
    await scratch.sql`INSERT INTO skill_revisions (id, skill_id, version, name, description, instructions)
      VALUES (${aV2}, ${a.skillId}, 2, 'a', '', '')`;
  });

  async function seedAssignments(rows: Array<{ skill: { skillId: string; skillRevisionId: string }; orderIndex: number }>) {
    for (const { skill, orderIndex } of rows) {
      await scratch.sql`INSERT INTO agent_skills (agent_id, skill_id, skill_revision_id, order_index, assignment_source)
        VALUES ('agent-1', ${skill.skillId}, ${skill.skillRevisionId}, ${orderIndex}, 'user_select')`;
    }
  }

  async function readRows() {
    const rows = await scratch.sql`SELECT skill_id, skill_revision_id, order_index
      FROM agent_skills WHERE agent_id = 'agent-1' ORDER BY order_index`;
    return rows.map((row) => ({
      skillId: row['skill_id'] as string,
      skillRevisionId: row['skill_revision_id'] as string,
      orderIndex: row['order_index'] as number,
    }));
  }

  async function readEvents() {
    const rows = await scratch.sql`SELECT skill_id, skill_revision_id, user_id, agent_id, event_type, metadata
      FROM skill_usage_events WHERE agent_id = 'agent-1' ORDER BY skill_id`;
    return rows.map((row) => ({
      skillId: row['skill_id'] as string,
      skillRevisionId: row['skill_revision_id'] as string,
      userId: row['user_id'] as string,
      eventType: row['event_type'] as string,
      metadata: row['metadata'] as unknown,
    }));
  }

  const sync = (assignments: Array<{ skillId: string; skillRevisionId: string }>, source: 'user_select' | 'agent_self' = 'user_select') =>
    db.transaction((tx) => syncAgentSkillAssignmentsInTx(tx, 'agent-1', 'user-U', assignments, source));

  it('inserts only-new assignments with ordered indexes, the passed source and one agent_assigned event each', async () => {
    await sync([a, b], 'agent_self');

    expect(await readRows()).toEqual([
      { skillId: a.skillId, skillRevisionId: a.skillRevisionId, orderIndex: 0 },
      { skillId: b.skillId, skillRevisionId: b.skillRevisionId, orderIndex: 1 },
    ]);
    const provenance = await scratch.sql`SELECT assignment_source, assigned_by_user_id FROM agent_skills WHERE agent_id = 'agent-1'`;
    expect(provenance).toEqual([
      { assignment_source: 'agent_self', assigned_by_user_id: 'user-U' },
      { assignment_source: 'agent_self', assigned_by_user_id: 'user-U' },
    ]);
    const expectedEvents = [a, b]
      .map((skill) => ({
        skillId: skill.skillId,
        skillRevisionId: skill.skillRevisionId,
        userId: 'user-U',
        eventType: 'agent_assigned',
        metadata: { source: 'agent_update' },
      }))
      .sort((x, y) => x.skillId.localeCompare(y.skillId));
    expect(await readEvents()).toEqual(expectedEvents);
  });

  it('deletes assignments missing from the list and emits no event for unchanged revisions', async () => {
    await seedAssignments([
      { skill: a, orderIndex: 0 },
      { skill: b, orderIndex: 1 },
      { skill: c, orderIndex: 2 },
    ]);

    await sync([a, c]);

    expect(await readRows()).toEqual([
      { skillId: a.skillId, skillRevisionId: a.skillRevisionId, orderIndex: 0 },
      { skillId: c.skillId, skillRevisionId: c.skillRevisionId, orderIndex: 1 },
    ]);
    expect(await readEvents()).toEqual([]);
  });

  it('removes every assignment when the list is empty', async () => {
    await seedAssignments([
      { skill: a, orderIndex: 0 },
      { skill: b, orderIndex: 1 },
    ]);

    await sync([]);

    expect(await readRows()).toEqual([]);
    expect(await readEvents()).toEqual([]);
  });

  it('adds one new skill after existing ones, with events only for the new skill', async () => {
    await seedAssignments([
      { skill: a, orderIndex: 0 },
      { skill: b, orderIndex: 1 },
    ]);

    await sync([a, b, c]);

    expect(await readRows()).toEqual([
      { skillId: a.skillId, skillRevisionId: a.skillRevisionId, orderIndex: 0 },
      { skillId: b.skillId, skillRevisionId: b.skillRevisionId, orderIndex: 1 },
      { skillId: c.skillId, skillRevisionId: c.skillRevisionId, orderIndex: 2 },
    ]);
    expect(await readEvents()).toEqual([
      {
        skillId: c.skillId,
        skillRevisionId: c.skillRevisionId,
        userId: 'user-U',
        eventType: 'agent_assigned',
        metadata: { source: 'agent_update' },
      },
    ]);
  });

  it('updates skill_revision_id of an existing row on a revision change and emits agent_assigned for it', async () => {
    await seedAssignments([
      { skill: a, orderIndex: 0 },
      { skill: b, orderIndex: 1 },
    ]);

    await sync([{ skillId: a.skillId, skillRevisionId: aV2 }, b]);

    expect(await readRows()).toEqual([
      { skillId: a.skillId, skillRevisionId: aV2, orderIndex: 0 },
      { skillId: b.skillId, skillRevisionId: b.skillRevisionId, orderIndex: 1 },
    ]);
    expect(await readEvents()).toEqual([
      {
        skillId: a.skillId,
        skillRevisionId: aV2,
        userId: 'user-U',
        eventType: 'agent_assigned',
        metadata: { source: 'agent_update' },
      },
    ]);
  });

  it('re-sequences order_index of surviving rows when the list is reordered', async () => {
    await seedAssignments([
      { skill: a, orderIndex: 0 },
      { skill: b, orderIndex: 1 },
      { skill: c, orderIndex: 2 },
    ]);

    await sync([c, a, b]);

    expect(await readRows()).toEqual([
      { skillId: c.skillId, skillRevisionId: c.skillRevisionId, orderIndex: 0 },
      { skillId: a.skillId, skillRevisionId: a.skillRevisionId, orderIndex: 1 },
      { skillId: b.skillId, skillRevisionId: b.skillRevisionId, orderIndex: 2 },
    ]);
    expect(await readEvents()).toEqual([]);
  });
});
