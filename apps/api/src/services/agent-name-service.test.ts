import { describe, it, expect } from 'vitest';
import type { Database } from '@herobids/db';
import { allocateAgentName } from './agent-name-service.js';

// Each candidate lookup consumes the next result: a row means that name is taken.
function fakeDbLookups(results: Array<Array<{ id: string }>>): Database {
  const queue = [...results];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue.shift() ?? []),
        }),
      }),
    }),
  } as unknown as Database;
}

describe('allocateAgentName', () => {
  it('returns the first candidate when the user has no agent with that name', async () => {
    const name = await allocateAgentName(fakeDbLookups([[]]), 'user-1', () => 0);

    expect(name).toBe('magical-cleaner');
  });

  it('moves to the next candidate when the first name is already taken', async () => {
    let rolls = 0;
    const random = () => (rolls++ < 2 ? 0 : 0.5);
    const name = await allocateAgentName(fakeDbLookups([[{ id: 'agent-1' }], []]), 'user-1', random);

    expect(name).not.toBe('magical-cleaner');
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
});
