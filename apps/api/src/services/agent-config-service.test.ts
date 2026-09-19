import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@herobids/db';

vi.mock('../agents/trading-profile-reconciliation-adapter.js', () => ({
  loadActiveTradingProfileConnections: vi.fn(),
}));

import { grantConnection, revokeConnection } from './agent-config-service.js';
import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';
import { planTradingProfileReconciliation, type TradingProfileConnection, type TypedTradingProfile } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfilePlannerInput } from '../agents/trading-profile-reconciliation-saga.js';

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

function buildStagedSaga(db: Database, onPrepared?: (input: TradingProfilePlannerInput) => void) {
  return {
    readCurrentProfiles: vi.fn(async (_ownerId: string, actorId: string, connections: TradingProfileConnection[]) => new Map(
      connections.flatMap((connection) => connection.venueAccountId === null ? [] : [[connection.venueAccountId, {
        actorId,
        venueAccountId: connection.venueAccountId,
        capital: '1000',
        riskPosture: null,
        executionDefaults: { mode: 'paper' },
      } satisfies TypedTradingProfile] as const]),
    )),
    executeStaged: vi.fn(async (input: {
      preparePlannerInput: () => Promise<TradingProfilePlannerInput>;
      commitLocal: (tx: unknown, markLocalCommitted: () => Promise<void>) => Promise<unknown>;
    }) => {
      const plannerInput = await input.preparePlannerInput();
      onPrepared?.(plannerInput);
      return db.transaction((tx) => input.commitLocal(tx, vi.fn().mockResolvedValue(undefined)));
    }),
  } as never;
}

describe('agent connection configuration reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('plans an imperative grant as the runtime default binding', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'connection-old', venueAccountId: 'venue-old', active: true, ready: true, isDefault: true },
    ]);
    const db = buildDb([
      [agent],
      [{ id: 'connection-new', userId: 'user-1', status: 'active', venueAccountId: 'venue-new' }],
      [],
      [agent],
      [{ userId: 'user-1', status: 'active' }],
      [],
    ]);
    let stagedInput: TradingProfilePlannerInput | undefined;
    const saga = buildStagedSaga(db, (input) => { stagedInput = input; });

    const result = await grantConnection(db, 'agent-1', 'connection-new', 'user-1', saga);

    expect(result.ok).toBe(true);
    const plannedGrant = stagedInput!.proposed.connections.find((connection) => connection.connectionId === 'connection-new')!;
    const insertedGrant = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedGrant.connectionId).toBe(plannedGrant.connectionId);
    expect(plannedGrant.isDefault).toBe(true);
    expect(planTradingProfileReconciliation(stagedInput!).selectedBinding.next).toEqual({
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
      [agent],
      [{ userId: 'user-1', status: 'active' }],
      [{ id: 'grant-current' }],
    ]);
    let stagedInput: TradingProfilePlannerInput | undefined;
    const saga = buildStagedSaga(db, (input) => { stagedInput = input; });

    const result = await revokeConnection(db, 'agent-1', 'connection-current', 'user-1', saga);

    expect(result.ok).toBe(true);
    const plan = planTradingProfileReconciliation(stagedInput!);
    expect(plan.selectedBinding).toEqual({
      previous: { connectionId: 'connection-current', venueAccountId: 'venue-current' },
      next: { connectionId: 'connection-fallback', venueAccountId: 'venue-fallback' },
    });
    expect(plan.inverseActions[0]).toEqual({
      kind: 'select_binding',
      binding: { connectionId: 'connection-current', venueAccountId: 'venue-current' },
    });
  });

  it('does not begin its local transaction until staged remote preparation completes', async () => {
    vi.mocked(loadActiveTradingProfileConnections).mockResolvedValue([
      { connectionId: 'connection-existing', venueAccountId: 'venue-existing', active: true, ready: true, isDefault: true },
    ]);
    const db = buildDb([
      [agent],
      [{ id: 'connection-new', userId: 'user-1', status: 'active', venueAccountId: 'venue-new' }],
      [],
      [agent],
      [{ userId: 'user-1', status: 'active' }],
      [],
    ]);
    let prepared = false;
    const saga = buildStagedSaga(db, () => { prepared = true; });

    await expect(grantConnection(db, 'agent-1', 'connection-new', 'user-1', saga)).resolves.toMatchObject({ ok: true });
    expect(prepared).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns an internal error without local writes when staged reconciliation compensates a remote failure', async () => {
    const db = buildDb([
      [agent],
      [{ id: 'connection-new', userId: 'user-1', status: 'active', venueAccountId: 'venue-new' }],
      [],
    ]);
    const saga = { executeStaged: vi.fn().mockRejectedValue(new Error('remote profile update failed after compensation')) } as never;

    const result = await grantConnection(db, 'agent-1', 'connection-new', 'user-1', saga);

    expect(result).toMatchObject({ ok: false, error: { code: 'config.internal_error' } });
    expect(db.insert).not.toHaveBeenCalled();
  });
});