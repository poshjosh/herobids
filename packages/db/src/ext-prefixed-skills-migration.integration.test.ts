import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { externalSkillIdForRef } from './external-skill-catalog.js';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';

// Runs only against a local Postgres (DATABASE_URL on localhost). It creates and drops its own
// database, so no existing data is read or changed. Skipped otherwise.
//
// Exercises migration 0091 (merge `ext:`-prefixed external skills into their canonical rows) on a
// database stopped at 0090. Written before the migration exists: until 0091 is added the
// migration file lookup throws and this suite fails.
const BASE_URL = localDatabaseUrl();
const PRE_MIGRATION = '0090_stiff_solo.sql';
const MIGRATIONS_DIR = new URL('../drizzle/', import.meta.url);

/** SQL of the 0091 migration, read at test time so the suite fails while the file is missing. */
function readMergeMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR).find((name) => /^0091_.+\.sql$/.test(name));
  if (!file) {
    throw new Error('migration file not found: packages/db/drizzle/0091_*.sql');
  }
  return readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
}

/** The id the pre-fix code derived for a prefixed ref: sha256 of the raw prefixed string. */
function legacyIdFor(prefixedRef: string): string {
  return `ext_${createHash('sha256').update(prefixedRef).digest('hex').slice(0, 24)}`;
}

// Evidence shape: skill A has a legacy row and a canonical row; skill B has only a legacy row.
const REF_A = 'openaidom/skills/job-search';
const LEGACY_REF_A = `ext:${REF_A}`;
const LEGACY_A = 'ext_5ed356e3a5c0385824eb9fbf';
const CANON_A = 'ext_54a85bf52d4cb1e1f8d46f7a';
const REF_B = 'acme/tools/scraper';
const LEGACY_REF_B = `ext:${REF_B}`;
const LEGACY_B = legacyIdFor(LEGACY_REF_B);
const CANON_B = externalSkillIdForRef(REF_B);

const rev = (skillId: string) => `${skillId}:external:1`;

const T_LEGACY_1 = new Date('2026-11-01T10:00:00.000Z');
const T_CANON_1 = new Date('2026-11-02T10:00:00.000Z');
const T_LEGACY_2 = new Date('2026-11-03T10:00:00.000Z');
const T_CANON_2 = new Date('2026-11-04T10:00:00.000Z');
const T_ONLY_A = new Date('2026-11-05T10:00:00.000Z');
const T_ONLY_B = new Date('2026-11-06T10:00:00.000Z');

const SNAPSHOT_TABLES = [
  'skills',
  'skill_revisions',
  'agent_skills',
  'skill_usage_events',
  'blueprint_revision_skills',
  'skill_entitlements',
  'skill_likes',
  'billing_usage_events',
];

describe.skipIf(!BASE_URL)('ext:-prefixed skills merge (0091, integration)', () => {
  let scratch: ScratchDatabase;
  let afterFirstRun: Record<string, unknown[]>;
  let afterSecondRun: Record<string, unknown[]>;

  const snapshot = async (): Promise<Record<string, unknown[]>> => {
    const result: Record<string, unknown[]> = {};
    for (const table of SNAPSHOT_TABLES) {
      result[table] = await scratch.sql.unsafe(
        `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      );
    }
    return result;
  };

  const insertSkill = async (id: string, ref: string, currentRevisionId: string) => {
    const sql = scratch.sql;
    await sql`INSERT INTO skills (id, slug, source_ref, name, description, instructions, publication_status, capability_families)
      VALUES (${id}, ${ref}, ${ref}, 'Job Search', 'Finds jobs', '', 'published', ARRAY['jobs']::text[])`;
    await sql`INSERT INTO skill_revisions (id, skill_id, version, name, description, instructions, source_ref, capability_families)
      VALUES (${currentRevisionId}, ${id}, 1, 'Job Search', 'Finds jobs', '', ${ref}, ARRAY['jobs']::text[])`;
    await sql`UPDATE skills SET current_revision_id = ${currentRevisionId}, published_revision_id = ${currentRevisionId}
      WHERE id = ${id}`;
  };

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, PRE_MIGRATION);
    const sql = scratch.sql;

    await sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-1', 'one', 'One', 'one@example.test'),
      ('user-2', 'two', 'Two', 'two@example.test')`;
    await sql`INSERT INTO agents (id, user_id, name, prompt) VALUES
      ('agent-both-1', 'user-1', 'Both 1', 'p'),
      ('agent-both-2', 'user-1', 'Both 2', 'p'),
      ('agent-legacy-a', 'user-1', 'Legacy A only', 'p'),
      ('agent-legacy-b', 'user-2', 'Legacy B only', 'p')`;

    // Skills: legacy A + canonical A, legacy B alone (no canonical row yet).
    await insertSkill(LEGACY_A, LEGACY_REF_A, rev(LEGACY_A));
    await insertSkill(CANON_A, REF_A, rev(CANON_A));
    await insertSkill(LEGACY_B, LEGACY_REF_B, rev(LEGACY_B));

    // agent_skills. Both-1: legacy order 0, canonical order 5. Both-2: legacy order 5, canonical order 0.
    // The legacy row's provenance differs from the canonical row's, so the survivor is identifiable.
    await sql`INSERT INTO agent_skills
        (agent_id, skill_id, skill_revision_id, order_index, assigned_at, assigned_by_user_id, assignment_source)
      VALUES
        ('agent-both-1', ${LEGACY_A}, ${rev(LEGACY_A)}, 0, ${T_LEGACY_1}, 'user-1', 'user_select'),
        ('agent-both-1', ${CANON_A}, ${rev(CANON_A)}, 5, ${T_CANON_1}, NULL, 'agent_self'),
        ('agent-both-2', ${LEGACY_A}, ${rev(LEGACY_A)}, 5, ${T_LEGACY_2}, NULL, 'agent_self'),
        ('agent-both-2', ${CANON_A}, ${rev(CANON_A)}, 0, ${T_CANON_2}, 'user-2', 'user_select'),
        ('agent-legacy-a', ${LEGACY_A}, ${rev(LEGACY_A)}, 2, ${T_ONLY_A}, 'user-1', 'user_select'),
        ('agent-legacy-b', ${LEGACY_B}, ${rev(LEGACY_B)}, 1, ${T_ONLY_B}, 'user-2', 'agent_self')`;

    await sql`INSERT INTO skill_usage_events (id, skill_id, skill_revision_id, user_id, agent_id, event_type, occurred_at) VALUES
      ('usage-a', ${LEGACY_A}, ${rev(LEGACY_A)}, 'user-1', 'agent-both-1', 'agent_assigned', ${T_LEGACY_1}),
      ('usage-b', ${LEGACY_B}, ${rev(LEGACY_B)}, 'user-2', 'agent-legacy-b', 'agent_assigned', ${T_ONLY_B})`;

    // Blueprint revision 1 holds only the legacy skill; revision 2 holds both spellings of skill A.
    await sql`INSERT INTO blueprints (id, author_id, kind, name) VALUES ('bp-1', 'user-1', 'agent', 'Blueprint')`;
    await sql`INSERT INTO blueprint_revisions (id, blueprint_id, version, kind, name, payload) VALUES
      ('bpr-1', 'bp-1', 1, 'agent', 'Blueprint', '{}'::jsonb),
      ('bpr-2', 'bp-1', 2, 'agent', 'Blueprint', '{}'::jsonb)`;
    await sql`INSERT INTO blueprint_revision_skills (blueprint_revision_id, skill_id, skill_revision_id, order_index) VALUES
      ('bpr-1', ${LEGACY_A}, ${rev(LEGACY_A)}, 0),
      ('bpr-2', ${CANON_A}, ${rev(CANON_A)}, 0),
      ('bpr-2', ${LEGACY_A}, ${rev(LEGACY_A)}, 1)`;

    // Entitlements and likes: user-1 holds both spellings of A (duplicate), user-2 only legacy rows.
    await sql`INSERT INTO skill_entitlements (skill_id, user_id) VALUES
      (${LEGACY_A}, 'user-1'), (${CANON_A}, 'user-1'), (${LEGACY_A}, 'user-2'), (${LEGACY_B}, 'user-2')`;
    await sql`INSERT INTO skill_likes (skill_id, user_id) VALUES
      (${LEGACY_A}, 'user-1'), (${CANON_A}, 'user-1'), (${LEGACY_A}, 'user-2'), (${LEGACY_B}, 'user-2')`;

    // Billing events carry skill_id without a foreign key.
    await sql`INSERT INTO billing_accounts (id, owner_user_id, active_plan_id) VALUES ('acct-1', 'user-1', 'plan-free')`;
    await sql`INSERT INTO billing_usage_events
        (id, account_id, user_id, agent_id, skill_id, source_type, meter_key, quantity, unit, idempotency_key, occurred_at)
      VALUES
        ('bill-a', 'acct-1', 'user-1', 'agent-both-1', ${LEGACY_A}, 'llm_call', 'llm.input_tokens', 10, 'tokens', 'idem-a', ${T_LEGACY_1}),
        ('bill-b', 'acct-1', 'user-1', 'agent-legacy-b', ${LEGACY_B}, 'llm_call', 'llm.input_tokens', 20, 'tokens', 'idem-b', ${T_ONLY_B})`;

    const migrationSql = readMergeMigration();
    await sql.unsafe(migrationSql).simple();
    afterFirstRun = await snapshot();
    await sql.unsafe(migrationSql).simple();
    afterSecondRun = await snapshot();
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  const currentRevisionOf = async (skillId: string): Promise<string | null> => {
    const [row] = await scratch.sql`SELECT current_revision_id FROM skills WHERE id = ${skillId}`;
    return (row?.['current_revision_id'] as string | null | undefined) ?? null;
  };

  it('leaves no skills row with an ext: source_ref or slug', async () => {
    const rows = await scratch.sql`SELECT id FROM skills WHERE source_ref LIKE 'ext:%' OR slug LIKE 'ext:%'`;
    expect(rows).toEqual([]);
    const revisions = await scratch.sql`SELECT id FROM skill_revisions WHERE source_ref LIKE 'ext:%'`;
    expect(revisions).toEqual([]);
  });

  it('keeps one canonical row per external skill, keyed by externalSkillIdForRef', async () => {
    const rows = await scratch.sql`SELECT id, slug, source_ref FROM skills WHERE source_ref IS NOT NULL ORDER BY source_ref`;
    expect(rows).toEqual([
      { id: externalSkillIdForRef(REF_B), slug: REF_B, source_ref: REF_B },
      { id: externalSkillIdForRef(REF_A), slug: REF_A, source_ref: REF_A },
    ].sort((a, b) => a.source_ref.localeCompare(b.source_ref)));
    expect(CANON_A).toBe(externalSkillIdForRef(REF_A));
  });

  it('gives every canonical row a current revision that belongs to it', async () => {
    for (const id of [CANON_A, CANON_B]) {
      const revisionId = await currentRevisionOf(id);
      expect(revisionId).not.toBeNull();
      const rows = await scratch.sql`SELECT id FROM skill_revisions WHERE id = ${revisionId!} AND skill_id = ${id}`;
      expect(rows).toHaveLength(1);
    }
  });

  it('leaves at most one agent_skills row per agent and skill', async () => {
    const duplicates = await scratch.sql`
      SELECT agent_id, skill_id FROM agent_skills GROUP BY agent_id, skill_id HAVING count(*) > 1`;
    expect(duplicates).toEqual([]);
    const [{ count }] = await scratch.sql`SELECT count(*)::int AS count FROM agent_skills` as unknown as [{ count: number }];
    expect(count).toBe(4);
  });

  it('points every skill reference at the canonical skill and its current revision', async () => {
    const canonicalIds = [CANON_A, CANON_B];
    const revisionByskill = new Map(
      await Promise.all(canonicalIds.map(async (id) => [id, await currentRevisionOf(id)] as const)),
    );

    const tables = ['agent_skills', 'skill_usage_events', 'blueprint_revision_skills'];
    for (const table of tables) {
      const rows = await scratch.sql.unsafe(`SELECT skill_id, skill_revision_id FROM "${table}"`);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) {
        expect(canonicalIds, `${table}.skill_id`).toContain(row['skill_id']);
        expect(row['skill_revision_id'], `${table}.skill_revision_id`).toBe(revisionByskill.get(row['skill_id'] as string));
      }
    }

    for (const table of ['skill_entitlements', 'skill_likes', 'billing_usage_events']) {
      const rows = await scratch.sql.unsafe(`SELECT skill_id FROM "${table}"`);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) {
        expect(canonicalIds, `${table}.skill_id`).toContain(row['skill_id']);
      }
    }
  });

  it('merges duplicate entitlements, likes and blueprint links without losing distinct ones', async () => {
    const entitlements = await scratch.sql`SELECT skill_id, user_id FROM skill_entitlements ORDER BY skill_id, user_id`;
    expect(entitlements).toEqual(
      [
        { skill_id: CANON_A, user_id: 'user-1' },
        { skill_id: CANON_A, user_id: 'user-2' },
        { skill_id: CANON_B, user_id: 'user-2' },
      ].sort((a, b) => a.skill_id.localeCompare(b.skill_id) || a.user_id.localeCompare(b.user_id)),
    );
    const likes = await scratch.sql`SELECT skill_id, user_id FROM skill_likes ORDER BY skill_id, user_id`;
    expect(likes).toHaveLength(3);
    const blueprintLinks = await scratch.sql`
      SELECT blueprint_revision_id, skill_id FROM blueprint_revision_skills ORDER BY blueprint_revision_id`;
    expect(blueprintLinks).toEqual([
      { blueprint_revision_id: 'bpr-1', skill_id: CANON_A },
      { blueprint_revision_id: 'bpr-2', skill_id: CANON_A },
    ]);
  });

  it('keeps usage and billing events, repointed', async () => {
    const usage = await scratch.sql`SELECT id, skill_id FROM skill_usage_events ORDER BY id`;
    expect(usage).toEqual([
      { id: 'usage-a', skill_id: CANON_A },
      { id: 'usage-b', skill_id: CANON_B },
    ]);
    const billing = await scratch.sql`SELECT id, skill_id FROM billing_usage_events ORDER BY id`;
    expect(billing).toEqual([
      { id: 'bill-a', skill_id: CANON_A },
      { id: 'bill-b', skill_id: CANON_B },
    ]);
  });

  it('carries the legacy row provenance onto the surviving assignment and keeps the lowest order_index', async () => {
    const rows = await scratch.sql`
      SELECT agent_id, skill_id, order_index, assigned_at, assigned_by_user_id, assignment_source
      FROM agent_skills ORDER BY agent_id`;
    expect(rows).toEqual([
      { agent_id: 'agent-both-1', skill_id: CANON_A, order_index: 0, assigned_at: T_LEGACY_1, assigned_by_user_id: 'user-1', assignment_source: 'user_select' },
      { agent_id: 'agent-both-2', skill_id: CANON_A, order_index: 0, assigned_at: T_LEGACY_2, assigned_by_user_id: null, assignment_source: 'agent_self' },
      { agent_id: 'agent-legacy-a', skill_id: CANON_A, order_index: 2, assigned_at: T_ONLY_A, assigned_by_user_id: 'user-1', assignment_source: 'user_select' },
      { agent_id: 'agent-legacy-b', skill_id: CANON_B, order_index: 1, assigned_at: T_ONLY_B, assigned_by_user_id: 'user-2', assignment_source: 'agent_self' },
    ]);
  });

  it('changes nothing when the migration runs a second time', () => {
    expect(afterSecondRun).toEqual(afterFirstRun);
  });
});
