import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';
import { userMessageReceiptState } from './user-message-receipt.js';

/** `coverageFirst` is the agent's creation time, where its stored history starts; `tickIds` is the `userMessageIds` of each stored tick. */
function fakeDb(coverageFirst: Date | null, tickIds: unknown[]): Database {
  const select = vi.fn()
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(coverageFirst ? [{ createdAt: coverageFirst }] : []),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(tickIds.map((userMessageIds) => ({ userMessageIds }))) }),
    });
  return { select } as unknown as Database;
}

const at = (iso: string) => new Date(iso);

describe('userMessageReceiptState', () => {
  it('reports true when a later tick lists the message ID, false when none does', async () => {
    const db = fakeDb(at('2026-11-05T00:00:00Z'), [['m-1'], []]);

    const states = await userMessageReceiptState(db, 'agent-1', [
      { id: 'm-1', createdAt: at('2026-11-06T10:29:25Z') },
      { id: 'm-2', createdAt: at('2026-11-06T10:30:26Z') },
    ]);

    expect(states.get('m-1')).toBe(true);
    expect(states.get('m-2')).toBe(false);
  });

  it('reports null for a message older than the stored history', async () => {
    const db = fakeDb(at('2026-11-06T00:00:00Z'), [[]]);

    const states = await userMessageReceiptState(db, 'agent-1', [
      { id: 'old', createdAt: at('2026-11-05T23:00:00Z') },
    ]);

    expect(states.get('old')).toBeNull();
  });

  it('reports null when the agent cannot be found', async () => {
    const db = fakeDb(null, []);

    const states = await userMessageReceiptState(db, 'agent-1', [{ id: 'm-1', createdAt: at('2026-11-06T10:00:00Z') }]);

    expect(states.get('m-1')).toBeNull();
  });

  it('ignores malformed payload values and returns an empty map for no messages', async () => {
    const db = fakeDb(at('2026-11-05T00:00:00Z'), [null, 'nope', [42, 'm-1']]);

    const states = await userMessageReceiptState(db, 'agent-1', [{ id: 'm-1', createdAt: at('2026-11-06T10:00:00Z') }]);
    expect(states.get('m-1')).toBe(true);

    const none = await userMessageReceiptState(fakeDb(null, []), 'agent-1', []);
    expect(none.size).toBe(0);
  });
});
