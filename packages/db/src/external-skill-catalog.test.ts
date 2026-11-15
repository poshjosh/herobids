import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Database } from './index.js';
import * as schema from './schema/index.js';
import { skillRevisions, skills } from './schema/index.js';
import {
  ensureExternalSkillIds,
  externalSkillIdForRef,
  normalizeSourceRefToSlug,
  setExternalSkillCapabilityFamilies,
} from './external-skill-catalog.js';
import { createScratchDatabase, localDatabaseUrl, type ScratchDatabase } from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';

interface Recorded {
  skillSets: Array<Record<string, unknown>>;
  revisionSets: Array<Record<string, unknown>>;
}

function fakeDb(existing: { id: string; currentRevisionId: string | null } | undefined): { db: Database; recorded: Recorded } {
  const recorded: Recorded = { skillSets: [], revisionSets: [] };
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existing ? [existing] : []),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        (table === skillRevisions ? recorded.revisionSets : table === skills ? recorded.skillSets : []).push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  const db = { transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as Database;
  return { db, recorded };
}

describe('setExternalSkillCapabilityFamilies', () => {
  it('writes only capabilityFamilies to the skill and its current revision', async () => {
    const { db, recorded } = fakeDb({ id: 'ext_1', currentRevisionId: 'ext_1:external:1' });

    await setExternalSkillCapabilityFamilies(db, 'traderton/skills/crypto-trading', ['trading']);

    expect(recorded.skillSets).toEqual([{ capabilityFamilies: ['trading'] }]);
    expect(recorded.revisionSets).toEqual([{ capabilityFamilies: ['trading'] }]);
  });

  it('does nothing when the ref is not catalogued', async () => {
    const { db, recorded } = fakeDb(undefined);

    await setExternalSkillCapabilityFamilies(db, 'traderton/skills/unknown', ['trading']);

    expect(recorded.skillSets).toEqual([]);
    expect(recorded.revisionSets).toEqual([]);
  });
});

// ── Bug condition exploration: `ext:`-prefixed refs (Property 1) ───────────
// Table-driven over generated (owner, repo, skill) triples; no property-testing library.

const OWNERS = ['openaidom', 'o', 'acme-labs'];
const REPOS = ['skills', 'r', 'tools'];
const SKILL_NAMES = ['job-search', 's', 'x1'];
const TRIPLES = OWNERS.flatMap((owner) =>
  REPOS.flatMap((repo) => SKILL_NAMES.map((skill) => ({ owner, repo, skill }))),
);

/** The three spellings of one external skill: UI id, canonical slug, CLI form. */
function spellings({ owner, repo, skill }: { owner: string; repo: string; skill: string }) {
  return {
    ui: `ext:${owner}/${repo}/${skill}`,
    canonical: `${owner}/${repo}/${skill}`,
    cli: `${owner}/${repo}@${skill}`,
  };
}

const EVIDENCE_ID = 'ext_54a85bf52d4cb1e1f8d46f7a';

describe('normalizeSourceRefToSlug with the ext: UI prefix', () => {
  it.each(TRIPLES)('strips the ext: prefix from ext:$owner/$repo/$skill', (triple) => {
    const { ui, canonical } = spellings(triple);
    expect(normalizeSourceRefToSlug(ui)).toBe(canonical);
  });

  it.each(TRIPLES)('strips the ext: prefix from the CLI form for $owner/$repo@$skill', (triple) => {
    const { canonical } = spellings(triple);
    expect(normalizeSourceRefToSlug(`ext:${triple.owner}/${triple.repo}@${triple.skill}`)).toBe(canonical);
  });

  it.each(TRIPLES)('strips repeated ext:ext: prefixes for $owner/$repo/$skill', (triple) => {
    const { canonical } = spellings(triple);
    expect(normalizeSourceRefToSlug(`ext:ext:${canonical}`)).toBe(canonical);
  });

  it('maps ext:openaidom/skills/job-search to openaidom/skills/job-search', () => {
    expect(normalizeSourceRefToSlug('ext:openaidom/skills/job-search')).toBe('openaidom/skills/job-search');
  });
});

describe('externalSkillIdForRef across spellings', () => {
  it('derives the evidence id for ext:, canonical and @ spellings of openaidom/skills/job-search', () => {
    expect(externalSkillIdForRef('openaidom/skills/job-search')).toBe(EVIDENCE_ID);
    expect(externalSkillIdForRef('openaidom/skills@job-search')).toBe(EVIDENCE_ID);
    expect(externalSkillIdForRef('ext:openaidom/skills/job-search')).toBe(EVIDENCE_ID);
  });

  it.each(TRIPLES)('derives one id for all spellings of $owner/$repo/$skill', (triple) => {
    const { ui, canonical, cli } = spellings(triple);
    const ids = new Set([ui, canonical, cli].map(externalSkillIdForRef));
    expect(ids.size).toBe(1);
  });
});

const BASE_URL = localDatabaseUrl();

describe.skipIf(!BASE_URL)('ensureExternalSkillIds with ext:-prefixed refs (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let db: Database;

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
    await truncate(scratch.sql, 'skills');
  });

  it.each(TRIPLES.slice(0, 4))(
    'resolves ext:, canonical and @ spellings of $owner/$repo/$skill to one id and one skills row',
    async (triple) => {
      const { ui, canonical, cli } = spellings(triple);

      const ids = await ensureExternalSkillIds(db, [ui, canonical, cli]);

      expect(new Set(ids).size).toBe(1);
      const rows = await scratch.sql`SELECT id FROM skills WHERE source_ref LIKE ${'%' + canonical}`;
      expect(rows).toHaveLength(1);
    },
  );

  it('stores no source_ref or slug starting with ext:', async () => {
    await ensureExternalSkillIds(db, ['ext:o/r/s', 'o/r/s', 'o/r@s']);

    const rows = await scratch.sql`SELECT source_ref, slug FROM skills
      WHERE source_ref LIKE 'ext:%' OR slug LIKE 'ext:%'`;
    expect(rows).toHaveLength(0);
  });

  it('returns the ext_ id derived from the canonical ref for an ext: input', async () => {
    const [id] = await ensureExternalSkillIds(db, ['ext:openaidom/skills/job-search']);

    expect(id).toBe(EVIDENCE_ID);
  });

  it('reuses a seeded canonical row for ext: and @ inputs without creating another row', async () => {
    const [seededId] = await ensureExternalSkillIds(db, ['o/r/s']);
    const before = await scratch.sql`SELECT id FROM skills`;

    const ids = await ensureExternalSkillIds(db, ['ext:o/r/s', 'ext:ext:o/r@s']);

    expect(ids).toEqual([seededId, seededId]);
    const after = await scratch.sql`SELECT id FROM skills`;
    expect(after).toHaveLength(before.length);
  });

  it('applies the operator family to an ext: input through the canonical ref', async () => {
    const [id] = await ensureExternalSkillIds(db, ['ext:o/r/s'], new Map([['o/r/s', 'trading']]));

    const [row] = await scratch.sql`SELECT capability_families FROM skills WHERE id = ${id!}`;
    expect(row?.capability_families).toEqual(['trading']);
  });
});

// ── Preservation (Property 4): inputs without the ext: prefix behave as before ──
// Baseline observed on unfixed code, then pinned. `legacyNormalize` is a frozen copy of the
// pre-fix `normalizeSourceRefToSlug`, so any later change in behavior for these inputs fails here.

function legacyNormalize(ref: string): string {
  const at = ref.indexOf('@');
  if (at >= 0 && ref.slice(0, at).includes('/')) {
    return `${ref.slice(0, at)}/${ref.slice(at + 1)}`;
  }
  return ref;
}

function legacyIdForRef(ref: string): string {
  return `ext_${crypto.createHash('sha256').update(legacyNormalize(ref)).digest('hex').slice(0, 24)}`;
}

/** Edge inputs that are not prefixed external refs: the prefix rule must leave them alone. */
const NON_REF_INPUTS = [
  'foo',
  'author/name',
  'system/programming',
  'programming',
  'a@b',
  'a/b@c',
  'a/b/c@d',
  'ext:foo',
  'ext:',
  'ext:a@b',
  'ext_5ed356e3a5c0385824eb9fbf',
];

const NON_PREFIXED_INPUTS = [
  ...TRIPLES.flatMap((triple) => {
    const { canonical, cli } = spellings(triple);
    return [canonical, cli];
  }),
  ...NON_REF_INPUTS,
];

describe('preservation: normalizeSourceRefToSlug and externalSkillIdForRef for non-prefixed inputs', () => {
  it.each(TRIPLES)('keeps owner/repo/skill unchanged for $owner/$repo/$skill', (triple) => {
    const { canonical } = spellings(triple);
    expect(normalizeSourceRefToSlug(canonical)).toBe(canonical);
  });

  it.each(TRIPLES)('rewrites owner/repo@skill to owner/repo/skill for $owner/$repo@$skill', (triple) => {
    const { canonical, cli } = spellings(triple);
    expect(normalizeSourceRefToSlug(cli)).toBe(canonical);
  });

  it('matches the pre-fix normalizer over every generated non-prefixed input', () => {
    for (const input of NON_PREFIXED_INPUTS) {
      expect(normalizeSourceRefToSlug(input), `normalize(${input})`).toBe(legacyNormalize(input));
    }
  });

  it('matches the pre-fix id derivation over every generated non-prefixed input', () => {
    for (const input of NON_PREFIXED_INPUTS) {
      expect(externalSkillIdForRef(input), `id(${input})`).toBe(legacyIdForRef(input));
    }
  });

  it.each(TRIPLES)('derives the same id for $owner/$repo/$skill and $owner/$repo@$skill', (triple) => {
    const { canonical, cli } = spellings(triple);
    expect(externalSkillIdForRef(canonical)).toBe(externalSkillIdForRef(cli));
  });

  it('keeps the evidence id for the canonical and CLI spellings of openaidom/skills/job-search', () => {
    expect(externalSkillIdForRef('openaidom/skills/job-search')).toBe(EVIDENCE_ID);
    expect(externalSkillIdForRef('openaidom/skills@job-search')).toBe(EVIDENCE_ID);
  });

  it('leaves ids and non-ref strings unchanged', () => {
    for (const input of ['ext:foo', 'ext:', 'ext_5ed356e3a5c0385824eb9fbf', 'system/programming', 'author/name']) {
      expect(normalizeSourceRefToSlug(input)).toBe(input);
    }
  });
});

describe.skipIf(!BASE_URL)('preservation: ensureExternalSkillIds for non-prefixed inputs (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let db: Database;

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
    await truncate(scratch.sql, 'skills');
  });

  async function insertPlatformSkill(id: string, slug: string) {
    await scratch.sql`INSERT INTO skills (id, slug, name, description, instructions, publication_status)
      VALUES (${id}, ${slug}, ${slug}, '', '', 'published')`;
  }

  async function countSkills(): Promise<number> {
    const [row] = await scratch.sql`SELECT count(*)::int AS n FROM skills`;
    return row!['n'] as number;
  }

  it('returns edge non-refs unchanged and creates no skills row', async () => {
    const inputs = ['ext:foo', 'ext:', 'ext_5ed356e3a5c0385824eb9fbf', 'system/programming', 'programming', 'author/name'];

    const ids = await ensureExternalSkillIds(db, inputs);

    expect(ids).toEqual(inputs);
    expect(await countSkills()).toBe(0);
  });

  it('resolves platform slug, legacy platform id and two-segment slug against the catalog without creating external rows', async () => {
    await insertPlatformSkill('programming', 'system/programming');
    await insertPlatformSkill('skill-author-name', 'author/name');

    const ids = await ensureExternalSkillIds(db, ['system/programming', 'programming', 'author/name']);

    expect(ids).toEqual(['programming', 'programming', 'skill-author-name']);
    expect(await countSkills()).toBe(2);
    const external = await scratch.sql`SELECT id FROM skills WHERE source_ref IS NOT NULL`;
    expect(external).toHaveLength(0);
  });

  it.each(TRIPLES.slice(0, 4))(
    'creates a placeholder metadata row for the unknown ref $owner/$repo/$skill and for its CLI form',
    async (triple) => {
      const { canonical, cli } = spellings(triple);

      const ids = await ensureExternalSkillIds(db, [canonical, cli]);

      const expectedId = legacyIdForRef(canonical);
      expect(ids).toEqual([expectedId, expectedId]);
      const rows = await scratch.sql`SELECT id, slug, source_ref, name, description, instructions FROM skills`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: expectedId,
        slug: canonical,
        source_ref: canonical,
        name: triple.skill,
        description: '',
        instructions: '',
      });
      const revisions = await scratch.sql`SELECT id, version FROM skill_revisions WHERE skill_id = ${expectedId}`;
      expect(revisions).toEqual([{ id: `${expectedId}:external:1`, version: 1 }]);
    },
  );

  it('reuses an already-catalogued row for the same ref instead of creating another', async () => {
    const [first] = await ensureExternalSkillIds(db, ['openaidom/skills/job-search']);
    const [second] = await ensureExternalSkillIds(db, ['openaidom/skills@job-search']);

    expect(first).toBe(EVIDENCE_ID);
    expect(second).toBe(EVIDENCE_ID);
    expect(await countSkills()).toBe(1);
  });

  it('keeps input order when mixing known platform ids, unknown refs and unknown non-ref ids', async () => {
    await insertPlatformSkill('programming', 'system/programming');

    const ids = await ensureExternalSkillIds(db, ['x/y/z', 'system/programming', 'ghost', 'x/y@z']);

    const placeholder = legacyIdForRef('x/y/z');
    expect(ids).toEqual([placeholder, 'programming', 'ghost', placeholder]);
  });

  it('applies the operator-declared family to a newly catalogued ref', async () => {
    const [id] = await ensureExternalSkillIds(
      db,
      ['traderton/skills/crypto-bot-management'],
      new Map([['traderton/skills/crypto-bot-management', 'trading']]),
    );

    const [row] = await scratch.sql`SELECT capability_families FROM skills WHERE id = ${id!}`;
    expect(row!['capability_families']).toEqual(['trading']);
  });

  it('keeps a backend-approved ref under its canonical ref with its families after the startup catalogue steps', async () => {
    // Mirrors apps/api/src/index.ts: ensureExternalSkillIds(approvedRefs) then setExternalSkillCapabilityFamilies per backend ref.
    const approvedRef = 'traderton/skills/crypto-trading';
    const [id] = await ensureExternalSkillIds(db, [approvedRef]);
    await setExternalSkillCapabilityFamilies(db, approvedRef, ['trading']);
    // A restart runs the same steps again.
    await ensureExternalSkillIds(db, [approvedRef]);
    await setExternalSkillCapabilityFamilies(db, approvedRef, ['trading']);

    expect(id).toBe(legacyIdForRef(approvedRef));
    const rows = await scratch.sql`SELECT id, slug, source_ref, capability_families FROM skills`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      slug: approvedRef,
      source_ref: approvedRef,
      capability_families: ['trading'],
    });
    const revisions = await scratch.sql`SELECT source_ref, capability_families FROM skill_revisions WHERE skill_id = ${id!}`;
    expect(revisions).toEqual([{ source_ref: approvedRef, capability_families: ['trading'] }]);
  });
});
