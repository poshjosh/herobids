import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { Database } from './index.js';
import { DecisionRepository } from './repositories.js';
import { openTestDb, truncate, type TestDb } from './test-helpers/integration-db.js';

const SKIP = !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('DecisionRepository.getLatestExitLevelsForInstrument (integration)', () => {
  let client: ReturnType<typeof postgres>;
  let db: TestDb;
  let repo: DecisionRepository;

  beforeAll(() => {
    const handle = openTestDb();
    db = handle.db;
    client = handle.client;
    repo = new DecisionRepository(db as unknown as Database);
  }, 30_000);

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncate(client, 'decisions');
  });

  it('since filter excludes decisions created before the boundary and includes those after', async () => {
    const agentId = 'agent-integration-test';
    const venueAccountId = 'va-integration-test';
    const instrumentId = 'BTC/USD:USD';

    const before = new Date('2026-01-01T10:00:00Z');
    const since = new Date('2026-01-01T12:00:00Z');
    const after = new Date('2026-01-01T14:00:00Z');

    // Decision BEFORE `since` — carries a stop-loss
    await repo.insertDecision({
      id: '00000000-0000-0000-0000-000000000001',
      venueAccountId,
      instrumentId,
      intent: 'go_long',
      targetSize: '1.0',
      actorType: 'agent',
      actorId: agentId,
      stopLoss: '85000',
    });

    // Manually back-date createdAt for the pre-since row
    await client.unsafe(
      `UPDATE decisions SET created_at = $1 WHERE id = $2`,
      [before, '00000000-0000-0000-0000-000000000001'],
    );

    // Decision AFTER `since` — no exit levels
    await repo.insertDecision({
      id: '00000000-0000-0000-0000-000000000002',
      venueAccountId,
      instrumentId,
      intent: 'increase',
      targetSize: '0.5',
      actorType: 'agent',
      actorId: agentId,
    });

    // Manually set createdAt for the post-since row
    await client.unsafe(
      `UPDATE decisions SET created_at = $1 WHERE id = $2`,
      [after, '00000000-0000-0000-0000-000000000002'],
    );

    // With `since` between the two rows, the pre-since stop-loss must not be returned
    const result = await repo.getLatestExitLevelsForInstrument(agentId, venueAccountId, instrumentId, since);

    // The post-since decision has no exit levels, so the result should be null
    expect(result).toBeNull();
  });

  it('returns exit levels from the most recent decision at or after since', async () => {
    const agentId = 'agent-integration-test-2';
    const venueAccountId = 'va-integration-test-2';
    const instrumentId = 'ETH/USD:USD';

    const since = new Date('2026-01-01T12:00:00Z');
    const after = new Date('2026-01-01T14:00:00Z');

    await repo.insertDecision({
      id: '00000000-0000-0000-0000-000000000003',
      venueAccountId,
      instrumentId,
      intent: 'go_long',
      targetSize: '2.0',
      actorType: 'agent',
      actorId: agentId,
      stopLoss: '3000',
      takeProfit: '4000',
    });

    await client.unsafe(
      `UPDATE decisions SET created_at = $1 WHERE id = $2`,
      [after, '00000000-0000-0000-0000-000000000003'],
    );

    const result = await repo.getLatestExitLevelsForInstrument(agentId, venueAccountId, instrumentId, since);

    expect(result).not.toBeNull();
    expect(result?.stopLoss).toBe('3000');
    expect(result?.takeProfit).toBe('4000');
  });
});
