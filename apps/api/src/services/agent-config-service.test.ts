import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn(),
  reconcileTradingProfile: vi.fn().mockResolvedValue({
    upserts: [], clears: [], selectedBinding: { previous: null, next: null }, inverseActions: [],
  }),
}));

import { grantConnection, revokeConnection } from './agent-config-service.js';
import {
  loadActiveTradingProfileConnections,
  reconcileTradingProfile,
} from '../agents/trading-profile-reconciliation-adapter.js';
import { planTradingProfileReconciliation } from '../agents/trading-profile-reconciliation.js';

function buildDb(selectResults: Array<Record<string, unknown>[]>): Database {
  let selectIndex = 0;
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectResults[selectIndex++] ?? [])),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
  };
  return db as unknown as Database;
}

const agent = {
  id: 'agent-1', userId: 'user-1', status: 'stopped', capital: null, riskPosture: null, executionDefaults: null,
};

describe('agent connection configuration reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plans an imperative grant using the exact newly inserted assignment as the newest binding', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'connection-old', venueAccountId: 'venue-old', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-old' },
    ]);
    const db = buildDb([
      [agent],
      [{ id: 'connection-new', userId: 'user-1', status: 'active', venueAccountId: 'venue-new' }],
      [],
    ]);

    const result = await grantConnection(db, 'agent-1', 'connection-new', 'user-1');

    expect(result.ok).toBe(true);
    const input = vi.mocked(reconcileTradingProfile).mock.calls[0]![0];
    const plannedGrant = input.proposed.connections.find((connection) => connection.connectionId === 'connection-new')!;
    const insertedGrant = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedGrant.id).toBe(plannedGrant.assignmentId);
    expect(insertedGrant.grantedAt).toBe(plannedGrant.grantedAt);
    expect(planTradingProfileReconciliation(input).selectedBinding.next).toEqual({
      connectionId: 'connection-new', venueAccountId: 'venue-new',
    });
  });

  it('plans an imperative revoke with a fallback transition and restoration inverse', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'connection-current', venueAccountId: 'venue-current', active: true, ready: true, grantedAt: new Date('2026-01-02'), assignmentId: 'grant-current' },
      { connectionId: 'connection-fallback', venueAccountId: 'venue-fallback', active: true, ready: true, grantedAt: new Date('2026-01-01'), assignmentId: 'grant-fallback' },
    ]);
    const db = buildDb([
      [agent],
      [{ id: 'connection-current', userId: 'user-1' }],
      [{ id: 'grant-current' }],
    ]);

    const result = await revokeConnection(db, 'agent-1', 'connection-current', 'user-1');

    expect(result.ok).toBe(true);
    const plan = planTradingProfileReconciliation(vi.mocked(reconcileTradingProfile).mock.calls[0]![0]);
    expect(plan.selectedBinding).toEqual({
      previous: { connectionId: 'connection-current', venueAccountId: 'venue-current' },
      next: { connectionId: 'connection-fallback', venueAccountId: 'venue-fallback' },
    });
    expect(plan.inverseActions[0]).toEqual({
      kind: 'select_binding',
      binding: { connectionId: 'connection-current', venueAccountId: 'venue-current' },
    });
  });
});