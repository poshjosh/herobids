/**
 * Unit tests for syncSystemSkills — slug field behavior.
 *
 * These tests mock the Drizzle database layer to verify that the `slug` field
 * is correctly set to `system/<skillId>` on both insert (new skill) and
 * update (existing skill with changed content) paths.
 *
 * The existing sync-system-skills.test.ts is an integration test requiring
 * a live DATABASE_URL. These unit tests run without a database.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import type { Database } from '@herobids/db';

// ── Mock SYSTEM_SKILLS before importing the module under test ────────────────

const MOCK_SKILLS: SkillDefinition[] = [
  {
    id: 'trading',
    slug: 'system/trading',
    name: 'Trading',
    description: 'Submit trade decisions and inspect trading state.',
    instructions: 'Use trading tools to submit decisions.',
    promptHint: undefined,
    promptTemplate: undefined,
    requiredTools: ['submit_decision'],
    capabilityFamilies: ['trading'],
    bindingRequirements: {},
    contextRequirements: ['positions'],
    requiredContextBlocks: [],
    promptRendererHints: [],
    requiredGuardrails: ['daily-loss'],
    suggestedTickIntervalMs: 900_000,
    visibility: 'public',
  },
  {
    id: 'bot-management',
    slug: 'system/bot-management',
    name: 'Bot Management',
    description: 'Create, start, stop, and monitor trading bots.',
    instructions: 'Use bot lifecycle tools.',
    promptHint: undefined,
    promptTemplate: undefined,
    requiredTools: ['create_bot'],
    capabilityFamilies: ['trading'],
    bindingRequirements: {},
    contextRequirements: [],
    requiredContextBlocks: [],
    promptRendererHints: [],
    requiredGuardrails: [],
    suggestedTickIntervalMs: 900_000,
    visibility: 'public',
  },
];

vi.mock('@herobids/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@herobids/domain')>();
  return { ...actual, SYSTEM_SKILLS: MOCK_SKILLS };
});

// ── Drizzle schema mocks — just need to be truthy table references ───────────

vi.mock('@herobids/db', () => ({
  skillRevisions: { id: 'skill_revisions.id', skillId: 'skill_revisions.skill_id' },
  skills: { id: 'skills.id', currentRevisionId: 'skills.current_revision_id' },
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

interface CapturedCall {
  type: 'insert' | 'update' | 'select' | 'execute';
  table?: unknown;
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

/**
 * Temporarily replace MOCK_SKILLS with a single skill for the duration of `fn`.
 * Restores the original array content on completion (success or failure).
 */
async function withSingleSkill<T>(skill: SkillDefinition, fn: () => Promise<T>): Promise<T> {
  const saved = [...MOCK_SKILLS];
  MOCK_SKILLS.length = 0;
  MOCK_SKILLS.push(skill);
  return fn().finally(() => {
    MOCK_SKILLS.length = 0;
    MOCK_SKILLS.push(...saved);
  });
}

/**
 * Build a mock Drizzle transaction that captures insert/update calls.
 *
 * The syncSystemSkills function uses this call pattern per skill:
 *   tx.execute(sql`...`)                    — advisory lock
 *   tx.select(...).from(...).where(...)...  — lookup existing skill
 *   tx.select(...).from(...).where(...)     — lookup current revision (if exists)
 *   tx.select(...).from(...).where(...)     — max version
 *   tx.update(...).set(...).where(...)      — update existing OR
 *   tx.insert(...).values(...)              — insert new
 *   tx.insert(skillRevisions).values(...)   — insert revision
 *   tx.update(...).set(...).where(...)      — patch revision pointers
 */
function buildMockTx(opts: {
  /** If provided, the first select (existing skill lookup) returns this row */
  existingSkill?: { id: string; currentRevisionId: string | null } | null;
  /** If provided, the revision lookup returns this row (for content comparison) */
  existingRevision?: Record<string, unknown> | null;
  /** Current max version. Default 0 (no prior versions). */
  maxVersion?: number;
}) {
  // Shared across all skills' transactions so assertions can inspect the full sequence.
  const calls: CapturedCall[] = [];
  let selectCallIndex = 0;

  // Drizzle query builders are thenable (not Promises) — mimicking that
  // behavior so `await tx.select(...)...` resolves correctly in the SUT.
  function buildSelectChain(): Record<string, Mock> {
    const callIndex = selectCallIndex++;
    const chain: Record<string, Mock> = {};

    const resolveResult = () => {
      if (callIndex === 0) {
        // First select: existing skill lookup
        return opts.existingSkill ? [opts.existingSkill] : [];
      } else if (callIndex === 1 && opts.existingSkill?.currentRevisionId) {
        // Second select: revision lookup (only if skill exists with a revision)
        return opts.existingRevision ? [opts.existingRevision] : [];
      } else {
        // Max version select
        return [{ max: opts.maxVersion ?? 0 }];
      }
    };

    const makeThenable = (obj: Record<string, Mock>) => {
      obj.then = vi.fn().mockImplementation((resolve: (v: unknown) => unknown) => {
        return Promise.resolve(resolve(resolveResult()));
      });
      Object.defineProperty(obj, Symbol.toStringTag, { value: 'Promise' });
      return obj;
    };

    chain.limit = vi.fn().mockImplementation(() => {
      calls.push({ type: 'select' });
      return makeThenable({ then: vi.fn() });
    });
    chain.for = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(makeThenable(chain));
    chain.from = vi.fn().mockReturnValue(chain);

    return makeThenable(chain);
  }

  function buildInsertChain(table: unknown) {
    return {
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        calls.push({ type: 'insert', table, values: v });
        return Promise.resolve();
      }),
    };
  }

  function buildUpdateChain(table: unknown) {
    let captured: Record<string, unknown> | undefined;
    const chain = {
      set: vi.fn().mockImplementation((s: Record<string, unknown>) => {
        captured = s;
        return chain;
      }),
      where: vi.fn().mockImplementation(() => {
        calls.push({ type: 'update', table, set: captured });
        return Promise.resolve();
      }),
    };
    return chain;
  }

  function buildTx() {
    // Reset per transaction so each skill gets a fresh select-call sequence
    selectCallIndex = 0;

    return {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockImplementation(() => buildSelectChain()),
      insert: vi.fn().mockImplementation((table: unknown) => buildInsertChain(table)),
      update: vi.fn().mockImplementation((table: unknown) => buildUpdateChain(table)),
    };
  }

  const db = {
    transaction: vi.fn().mockImplementation((cb: (tx: unknown) => Promise<void>) => cb(buildTx())),
  } as unknown as Database;

  return { db, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('syncSystemSkills — slug field', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('sets slug to system/<skillId> when inserting a new skill', async () => {
    await withSingleSkill(MOCK_SKILLS[0]!, async () => {
      const { db, calls } = buildMockTx({
        existingSkill: null,
        maxVersion: 0,
      });

      const { syncSystemSkills } = await import('./sync-system-skills.js');
      await syncSystemSkills(db);

      const skillInserts = calls.filter(
        (c) => c.type === 'insert' && c.values?.['id'] === 'trading',
      );
      expect(skillInserts).toHaveLength(1);
      expect(skillInserts[0]!.values!['slug']).toBe('system/trading');
    });
  });

  it('sets slug to system/<skillId> when updating an existing skill with changed content', async () => {
    const skill = MOCK_SKILLS[0]!;

    await withSingleSkill(skill, async () => {
      const { db, calls } = buildMockTx({
        existingSkill: { id: skill.id, currentRevisionId: 'trading:system:1' },
        existingRevision: {
          id: 'trading:system:1',
          name: skill.name,
          description: skill.description,
          instructions: 'OLD instructions that differ from incoming',
          promptHint: null,
          promptTemplate: null,
          requiredTools: skill.requiredTools,
          contextRequirements: skill.contextRequirements,
          requiredGuardrails: skill.requiredGuardrails,
          capabilityFamilies: skill.capabilityFamilies,
          suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
          tags: [],
        },
        maxVersion: 1,
      });

      const { syncSystemSkills } = await import('./sync-system-skills.js');
      await syncSystemSkills(db);

      const skillUpdates = calls.filter(
        (c) => c.type === 'update' && c.set?.['slug'] !== undefined,
      );
      expect(skillUpdates.length).toBeGreaterThanOrEqual(1);
      expect(skillUpdates[0]!.set!['slug']).toBe('system/trading');
    });
  });

  it('generates correct slug pattern for each system skill ID', async () => {
    const { db, calls } = buildMockTx({
      existingSkill: null,
      maxVersion: 0,
    });

    const { syncSystemSkills } = await import('./sync-system-skills.js');
    await syncSystemSkills(db);

    // Every skill should produce a skills-table insert
    const skillInserts = calls.filter(
      (c) => c.type === 'insert' && c.values?.['publicationStatus'] === 'published',
    );
    expect(skillInserts).toHaveLength(MOCK_SKILLS.length);

    // Verify slug for every skill
    for (const skill of MOCK_SKILLS) {
      const insertCall = calls.find(
        (c) => c.type === 'insert' && c.values?.['id'] === skill.id,
      );
      expect(insertCall, `expected insert for skill ${skill.id}`).toBeDefined();
      expect(insertCall!.values!['slug']).toBe(`system/${skill.id}`);
    }

    // Spot-check specific known slugs
    const tradingInsert = calls.find(
      (c) => c.type === 'insert' && c.values?.['id'] === 'trading',
    );
    expect(tradingInsert!.values!['slug']).toBe('system/trading');

    const botInsert = calls.find(
      (c) => c.type === 'insert' && c.values?.['id'] === 'bot-management',
    );
    expect(botInsert!.values!['slug']).toBe('system/bot-management');
  });

  it('skips update when content hash matches (no slug write needed)', async () => {
    const skill = MOCK_SKILLS[0]!;

    await withSingleSkill(skill, async () => {
      const { db, calls } = buildMockTx({
        existingSkill: { id: skill.id, currentRevisionId: 'trading:system:1' },
        existingRevision: {
          id: 'trading:system:1',
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          promptHint: skill.promptHint ?? null,
          promptTemplate: skill.promptTemplate ?? null,
          requiredTools: [...skill.requiredTools],
          contextRequirements: [...skill.contextRequirements],
          requiredGuardrails: [...skill.requiredGuardrails],
          capabilityFamilies: [...skill.capabilityFamilies],
          suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
          tags: [],
        },
        maxVersion: 1,
      });

      const { syncSystemSkills } = await import('./sync-system-skills.js');
      await syncSystemSkills(db);

      const mutations = calls.filter((c) => c.type === 'insert' || c.type === 'update');
      expect(mutations).toHaveLength(0);
    });
  });

  it('slug on insert includes all expected row fields alongside slug', async () => {
    const skill = MOCK_SKILLS[0]!;

    await withSingleSkill(skill, async () => {
      const { db, calls } = buildMockTx({
        existingSkill: null,
        maxVersion: 0,
      });

      const { syncSystemSkills } = await import('./sync-system-skills.js');
      await syncSystemSkills(db);

      const skillInsert = calls.find(
        (c) => c.type === 'insert' && c.values?.['id'] === skill.id,
      );
      expect(skillInsert).toBeDefined();

      const values = skillInsert!.values!;
      expect(values['slug']).toBe('system/trading');
      expect(values['id']).toBe('trading');
      expect(values['publicationStatus']).toBe('published');
      expect(values['authorId']).toBeNull();
      expect(values['name']).toBe(skill.name);
      expect(values['description']).toBe(skill.description);
      expect(values['instructions']).toBe(skill.instructions);
    });
  });

  it('slug on update includes publicationStatus and other skill fields', async () => {
    const skill = MOCK_SKILLS[0]!;

    await withSingleSkill(skill, async () => {
      const { db, calls } = buildMockTx({
        existingSkill: { id: skill.id, currentRevisionId: 'trading:system:1' },
        existingRevision: {
          id: 'trading:system:1',
          name: skill.name,
          description: 'Old description that triggers update',
          instructions: skill.instructions,
          promptHint: null,
          promptTemplate: null,
          requiredTools: [...skill.requiredTools],
          contextRequirements: [...skill.contextRequirements],
          requiredGuardrails: [...skill.requiredGuardrails],
          capabilityFamilies: [...skill.capabilityFamilies],
          suggestedTickIntervalMs: skill.suggestedTickIntervalMs,
          tags: [],
        },
        maxVersion: 1,
      });

      const { syncSystemSkills } = await import('./sync-system-skills.js');
      await syncSystemSkills(db);

      const updates = calls.filter((c) => c.type === 'update');
      expect(updates.length).toBeGreaterThanOrEqual(1);

      const skillUpdate = updates.find((c) => c.set?.['slug'] !== undefined)!;
      expect(skillUpdate.set!['slug']).toBe('system/trading');
      expect(skillUpdate.set!['publicationStatus']).toBe('published');
      expect(skillUpdate.set!['name']).toBe(skill.name);
      expect(skillUpdate.set!['description']).toBe(skill.description);
    });
  });
});
