import { describe, it, expect, vi } from 'vitest';
import type { Database } from './index.js';
import { skillRevisions, skills } from './schema/index.js';
import { setExternalSkillCapabilityFamilies } from './external-skill-catalog.js';

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
