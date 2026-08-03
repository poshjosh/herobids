import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_SKILLS } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { skillRevisions, skills as skillsTable } from '@herobids/db';
import { syncSystemSkills } from './sync-system-skills.js';

function makeSelectChain(result: unknown[]) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    for: vi.fn(() => chain),
  };

  (chain as { then: unknown }).then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);

  return chain;
}

function createFakeDb() {
  const skillsById = new Map<string, Record<string, unknown>>();
  const revisionsById = new Map<string, Record<string, unknown>>();
  const revisionsBySkillId = new Map<string, Record<string, unknown>>();

  const baseOps = {
    select: vi.fn().mockImplementation(() => {
      let fromTable: unknown = null;
      const chain: Record<string, unknown> = {
        from: vi.fn((table: unknown) => {
          fromTable = table;
          return chain;
        }),
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        for: vi.fn(() => chain),
      };
      (chain as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
      ) => {
        // Max-version queries go through skillRevisions — always return [{ max: 0 }]
        // Existing-skill checks go through skillsTable — return the current map contents
        if (fromTable === skillRevisions) {
          resolve(Array.from(revisionsById.values()));
        } else {
          resolve(Array.from(skillsById.values()));
        }
        return chain;
      };
      return chain;
    }),
    insert: vi.fn((table: typeof skillsTable | typeof skillRevisions) => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (table === skillsTable) {
          skillsById.set(row.id as string, { ...row });
        } else {
          revisionsById.set(row.id as string, { ...row });
          revisionsBySkillId.set(row.skillId as string, { ...row });
        }
        return Promise.resolve(undefined);
      }),
    })),
    update: vi.fn((table: typeof skillsTable | typeof skillRevisions) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (table === skillsTable) {
            for (const [id, existing] of skillsById) {
              skillsById.set(id, { ...existing, ...data });
            }
          }
          return Promise.resolve(undefined);
        }),
      })),
    })),
    execute: vi.fn().mockResolvedValue([]),
  };

  const db = {
    ...baseOps,
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...baseOps })),
  } as unknown as Database;

  return { db, skillsById, revisionsById, revisionsBySkillId };
}

describe('syncSystemSkills', () => {
  it('upserts all system skills and updates changed content on a second run', async () => {
    const { db, skillsById, revisionsById, revisionsBySkillId } = createFakeDb();
    const firstSkill = SYSTEM_SKILLS[0];
    const originalInstructions = firstSkill.instructions;

    try {
      await syncSystemSkills(db);

      expect(skillsById.size).toBe(SYSTEM_SKILLS.length);
      expect(revisionsById.size).toBe(SYSTEM_SKILLS.length);
      expect(skillsById.get(firstSkill.id)?.instructions).toBe(originalInstructions);

      const updatedInstructions = `${originalInstructions}\nUpdated during sync test.`;
      (firstSkill as typeof firstSkill & { instructions: string }).instructions = updatedInstructions;

      await syncSystemSkills(db);

      expect(skillsById.size).toBe(SYSTEM_SKILLS.length);
      expect(revisionsById.size).toBe(SYSTEM_SKILLS.length);
      expect(skillsById.get(firstSkill.id)?.instructions).toBe(updatedInstructions);
      expect(revisionsBySkillId.get(firstSkill.id)?.instructions).toBe(updatedInstructions);
    } finally {
      (firstSkill as typeof firstSkill & { instructions: string }).instructions = originalInstructions;
    }
  });
});