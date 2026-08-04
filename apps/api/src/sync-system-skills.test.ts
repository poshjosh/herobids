import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_SKILLS } from '@herobids/domain';
import type { Database } from '@herobids/db';
import { skillRevisions, skills as skillsTable } from '@herobids/db';
import { syncSystemSkills } from './sync-system-skills.js';

/**
 * Extract the column name and expected value from a Drizzle eq() condition.
 * eq() returns an SQL object whose queryChunks array contains:
 *   [StringChunk, ColumnDef (with .name), StringChunk(' = '), Param (with .value), StringChunk]
 */
function extractEqCondition(condition: unknown): { column: string; value: unknown } | null {
  if (!condition || typeof condition !== 'object') return null;
  const cond = condition as Record<string, unknown>;
  const chunks = cond.queryChunks as Array<Record<string, unknown>> | undefined;
  if (!chunks || !Array.isArray(chunks)) return null;

  let colName: string | null = null;
  let paramValue: unknown = undefined;

  for (const chunk of chunks) {
    if (chunk && typeof chunk === 'object' && 'name' in chunk && 'table' in chunk) {
      // This is a column definition (e.g., PgText)
      colName = chunk.name as string;
    }
    if (chunk && typeof chunk === 'object' && 'value' in chunk && 'encoder' in chunk) {
      // This is a Param with the bound value
      paramValue = chunk.value;
    }
  }

  if (!colName || paramValue === undefined) return null;
  return { column: colName, value: paramValue };
}

function createFakeDb() {
  const skillsById = new Map<string, Record<string, unknown>>();
  const revisionsById = new Map<string, Record<string, unknown>>();
  const revisionsBySkillId = new Map<string, Record<string, unknown>>();

  const baseOps = {
    select: vi.fn().mockImplementation(() => {
      let fromTable: unknown = null;
      let whereCondition: unknown = null;
      const chain: Record<string, unknown> = {
        from: vi.fn((table: unknown) => {
          fromTable = table;
          return chain;
        }),
        where: vi.fn((condition: unknown) => {
          whereCondition = condition;
          return chain;
        }),
        limit: vi.fn(() => chain),
        for: vi.fn(() => chain),
      };
      (chain as { then: unknown }).then = (
        resolve: (value: unknown) => unknown,
      ) => {
        if (fromTable === skillRevisions) {
          const allRevs = Array.from(revisionsById.values());
          const filter = extractEqCondition(whereCondition);
          if (filter) {
            // Filter by column name: 'id' or 'skill_id'
            const filtered = allRevs.filter((row) => row[filter.column] === filter.value);
            resolve(filtered);
          } else {
            resolve(allRevs);
          }
        } else {
          const allSkills = Array.from(skillsById.values());
          const filter = extractEqCondition(whereCondition);
          if (filter) {
            const filtered = allSkills.filter((row) => row[filter.column] === filter.value);
            resolve(filtered);
          } else {
            resolve(allSkills);
          }
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
      set: vi.fn((data: Record<string, unknown>) => {
        let updateWhere: unknown = null;
        return {
          where: vi.fn(async (condition: unknown) => {
            updateWhere = condition;
            if (table === skillsTable) {
              const filter = extractEqCondition(condition);
              if (filter && filter.column === 'id') {
                const existing = skillsById.get(filter.value as string);
                if (existing) {
                  skillsById.set(filter.value as string, { ...existing, ...data });
                }
              } else {
                // Fallback: update all (no filter matched)
                for (const [id, existing] of skillsById) {
                  skillsById.set(id, { ...existing, ...data });
                }
              }
            }
            return Promise.resolve(undefined);
          }),
        };
      }),
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