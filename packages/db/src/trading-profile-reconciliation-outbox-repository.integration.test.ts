import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { TradingProfileReconciliationOutboxRepository } from './trading-profile-reconciliation-outbox-repository.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('TradingProfileReconciliationOutboxRepository (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repository: TradingProfileReconciliationOutboxRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repository = new TradingProfileReconciliationOutboxRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'trading_profile_reconciliation_outbox');
  });

  function input(operationId: string) {
    return {
      operationId,
      localMutationId: 'mutation-1',
      ownerId: 'owner-1',
      actorId: 'agent-1',
      actions: [{ actionId: 'action-1', kind: 'set' as const, venueAccountId: 'venue-1', state: 'pending' as const, attempts: 0, error: null }],
    };
  }

  it('creates one durable operation for concurrent retries of the same local mutation', async () => {
    const [first, second] = await Promise.all([
      repository.createOrLoad(input('operation-1')),
      repository.createOrLoad(input('operation-2')),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.operationId).toBe('operation-1');
    expect(second.operationId).toBe('operation-1');
  });

  it('allows only one recovery worker to claim a recoverable operation', async () => {
    await repository.createOrLoad(input('operation-1'));

    const [first, second] = await Promise.all([
      repository.claimRecoverable(10, 60_000),
      repository.claimRecoverable(10, 60_000),
    ]);

    expect([first.length, second.length].sort()).toEqual([0, 1]);
    const claim = first[0] ?? second[0];
    expect(claim?.claimToken).toBeTruthy();
    expect(claim?.claimExpiresAt).toBeInstanceOf(Date);
  });

  it('durably records terminal fanout transitions by operation id', async () => {
    const created = await repository.createOrLoad(input('operation-1'));

    await repository.updateByOperationId(created.operationId, 'completed');
    const completed = await repository.claimRecoverable(10, 60_000);
    expect(completed).toEqual([]);

    await repository.updateByOperationId(created.operationId, 'rollback_pending', 'transport unavailable');
    const pending = await repository.claimRecoverable(10, 60_000);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operationId: created.operationId, state: 'rollback_pending', lastError: 'transport unavailable' });
  });
});