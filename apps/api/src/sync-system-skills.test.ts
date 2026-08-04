import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_SKILLS } from '@herobids/domain';
import { closeDatabase, createDatabase, skillRevisions, skills, type Database } from '@herobids/db';
import { syncSystemSkills } from './sync-system-skills.js';
import { truncateAll } from './__tests__/functional/helpers.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('syncSystemSkills', () => {
  let db: Database | undefined;

  beforeAll(async () => {
    db = createDatabase(process.env['DATABASE_URL']!);
  });

  afterAll(async () => {
    if (db) {
      await closeDatabase(db);
    }
  });

  beforeEach(async () => {
    if (!db) {
      throw new Error('database not initialised');
    }
    await truncateAll(db);
  });

  it('re-seeds changed system skill content in Postgres', async () => {
    if (!db) {
      throw new Error('database not initialised');
    }

    const firstSkill = SYSTEM_SKILLS[0];
    const originalInstructions = firstSkill.instructions;
    const updatedInstructions = `${originalInstructions}\nUpdated during integration test.`;

    try {
      const beforeSkills = await db.select().from(skills);
      const beforeRevisions = await db.select().from(skillRevisions);

      await syncSystemSkills(db);

      const unchangedSkills = await db.select().from(skills);
      const unchangedRevisions = await db.select().from(skillRevisions);

      expect(unchangedSkills).toHaveLength(beforeSkills.length);
      expect(unchangedRevisions).toHaveLength(beforeRevisions.length);

      (firstSkill as typeof firstSkill & { instructions: string }).instructions = updatedInstructions;

      await syncSystemSkills(db);

      const afterSkills = await db.select().from(skills);
      const afterRevisions = await db.select().from(skillRevisions);
      const storedSkill = afterSkills.find((row) => row.id === firstSkill.id);
      const storedRevision = afterRevisions.find(
        (row) => row.skillId === firstSkill.id && row.instructions === updatedInstructions,
      );

      expect(afterSkills).toHaveLength(beforeSkills.length);
      expect(afterRevisions).toHaveLength(beforeRevisions.length + 1);
      expect(storedSkill?.instructions).toBe(updatedInstructions);
      expect(storedSkill?.currentRevisionId).toBe(storedRevision?.id);
      expect(storedSkill?.publishedRevisionId).toBe(storedRevision?.id);
      expect(storedRevision?.version).toBeGreaterThan(1);
    } finally {
      (firstSkill as typeof firstSkill & { instructions: string }).instructions = originalInstructions;
    }
  });
});