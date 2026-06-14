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
  let selectCallIndex = 0;

  const db = {
    select: vi.fn(() => {
      const skill = SYSTEM_SKILLS[selectCallIndex++];
      const existingRevision = skill ? revisionsBySkillId.get(skill.id) : undefined;
      return makeSelectChain(existingRevision ? [{ id: existingRevision.id }] : []);
    }),
    insert: vi.fn((table: typeof skillsTable | typeof skillRevisions) => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          if (table === skillsTable) {
            const current = skillsById.get(row.id as string) ?? {};
            const next = { ...current, ...row, ...set };
            skillsById.set(row.id as string, next);
            return;
          }

          const current = revisionsById.get(row.id as string) ?? {};
          const next = { ...current, ...row, ...set };
          revisionsById.set(row.id as string, next);
          revisionsBySkillId.set(row.skillId as string, next);
        },
      })),
    })),
  } as unknown as Database;

  return { db, skillsById, revisionsById, revisionsBySkillId, selectCallCount: () => selectCallIndex };
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