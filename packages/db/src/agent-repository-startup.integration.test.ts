import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { AgentRepository } from './agent-repository.js';
import * as schema from './schema/index.js';
import {
  createScratchDatabase,
  localDatabaseUrl,
  type ScratchDatabase,
} from './test-helpers/scratch-database.js';
import { truncate } from './test-helpers/integration-db.js';

// Runs only against a local Postgres (DATABASE_URL on localhost), in a database it creates and drops.
const BASE_URL = localDatabaseUrl();
const ALL_MIGRATIONS = '9999_all.sql';

const T0 = new Date('2026-10-30T10:00:00.000Z');
const T1 = new Date('2026-10-30T10:01:00.000Z');
const T2 = new Date('2026-10-30T10:02:00.000Z');

describe.skipIf(!BASE_URL)('AgentRepository startup facts (integration)', () => {
  let scratch: ScratchDatabase;
  let pool: postgres.Sql;
  let repo: AgentRepository;
  let sessionId: string;

  beforeAll(async () => {
    scratch = await createScratchDatabase(BASE_URL!, ALL_MIGRATIONS);
    const { host, port, user, pass, database } = scratch.sql.options;
    pool = postgres({ host: host[0], port: port[0], user, pass: pass ?? undefined, database }, { max: 1 });
    repo = new AgentRepository(drizzle(pool, { schema }));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    await truncate(scratch.sql, 'agent_runtime_sessions', 'agents', 'users');
    await scratch.sql`INSERT INTO users (id, username, display_name, email) VALUES
      ('user-1', 'owner', 'Owner', 'owner@example.test')`;
    await scratch.sql`INSERT INTO agents (id, user_id, name, prompt, status) VALUES
      ('agent-1', 'user-1', 'Momo', 'p', 'active')`;
    sessionId = await repo.createSession({ agentId: 'agent-1' });
  });

  async function readSession() {
    const [row] = await scratch.sql`SELECT status, runtime_registered_at, first_placed_at, placement_allocation_id
      FROM agent_runtime_sessions WHERE id = ${sessionId}`;
    return {
      status: row.status as string,
      runtimeRegisteredAt: row.runtime_registered_at as Date | null,
      firstPlacedAt: row.first_placed_at as Date | null,
      placementAllocationId: row.placement_allocation_id as string | null,
    };
  }

  async function setStatus(status: string) {
    await scratch.sql`UPDATE agent_runtime_sessions SET status = ${status} WHERE id = ${sessionId}`;
  }

  describe('markRuntimeRegistered', () => {
    it('sets the registration time once and ignores later calls', async () => {
      expect(await repo.markRuntimeRegistered(sessionId, T1)).toBe(true);
      expect(await repo.markRuntimeRegistered(sessionId, T2)).toBe(false);

      expect((await readSession()).runtimeRegisteredAt?.toISOString()).toBe(T1.toISOString());
    });

    it('records registration for a launching session', async () => {
      await setStatus('launching');

      expect(await repo.markRuntimeRegistered(sessionId, T1)).toBe(true);
      expect((await readSession()).runtimeRegisteredAt?.toISOString()).toBe(T1.toISOString());
    });

    it.each(['stopped', 'crashed'])('does not record registration for a %s session', async (status) => {
      await setStatus(status);

      expect(await repo.markRuntimeRegistered(sessionId, T1)).toBe(false);
      expect((await readSession()).runtimeRegisteredAt).toBeNull();
    });
  });

  describe('recordFirstPlacement', () => {
    it('records the first placement', async () => {
      expect(await repo.recordFirstPlacement(sessionId, T1, 'alloc-a')).toBe(true);

      const session = await readSession();
      expect(session.firstPlacedAt?.toISOString()).toBe(T1.toISOString());
      expect(session.placementAllocationId).toBe('alloc-a');
    });

    it('does not move the placement later', async () => {
      await repo.recordFirstPlacement(sessionId, T1, 'alloc-a');

      expect(await repo.recordFirstPlacement(sessionId, T2, 'alloc-b')).toBe(false);

      const session = await readSession();
      expect(session.firstPlacedAt?.toISOString()).toBe(T1.toISOString());
      expect(session.placementAllocationId).toBe('alloc-a');
    });

    it('does not replace the placement with an equal time', async () => {
      await repo.recordFirstPlacement(sessionId, T1, 'alloc-a');

      expect(await repo.recordFirstPlacement(sessionId, T1, 'alloc-b')).toBe(false);
      expect((await readSession()).placementAllocationId).toBe('alloc-a');
    });

    it('replaces the placement and allocation id with an earlier time', async () => {
      await repo.recordFirstPlacement(sessionId, T2, 'alloc-late');

      expect(await repo.recordFirstPlacement(sessionId, T1, 'alloc-early')).toBe(true);

      const session = await readSession();
      expect(session.firstPlacedAt?.toISOString()).toBe(T1.toISOString());
      expect(session.placementAllocationId).toBe('alloc-early');
    });

    it.each(['stopped', 'crashed'])('does not record placement for a %s session', async (status) => {
      await setStatus(status);

      expect(await repo.recordFirstPlacement(sessionId, T1, 'alloc-a')).toBe(false);

      const session = await readSession();
      expect(session.firstPlacedAt).toBeNull();
      expect(session.placementAllocationId).toBeNull();
    });
  });

  describe('expireStartingSession (atomic startup expiry claim)', () => {
    it('claims a starting session whose startup facts are unchanged', async () => {
      expect(await repo.expireStartingSession(sessionId, T2, {
        status: 'starting', runtimeRegisteredAt: null, firstPlacedAt: null,
      })).toBe(true);

      expect((await readSession()).status).toBe('stopped');
    });

    it('claims a launching session whose registration matches', async () => {
      await setStatus('launching');
      await repo.markRuntimeRegistered(sessionId, T1);

      expect(await repo.expireStartingSession(sessionId, T2, {
        status: 'launching', runtimeRegisteredAt: T1, firstPlacedAt: null,
      })).toBe(true);
      expect((await readSession()).status).toBe('stopped');
    });

    it('fails when a placement landed after the claimant observed the session', async () => {
      await setStatus('launching');
      await repo.markRuntimeRegistered(sessionId, T1);
      await repo.recordFirstPlacement(sessionId, T1, 'alloc-a');

      expect(await repo.expireStartingSession(sessionId, T2, {
        status: 'launching', runtimeRegisteredAt: T1, firstPlacedAt: null,
      })).toBe(false);

      const session = await readSession();
      expect(session.status).toBe('launching');
      expect(session.firstPlacedAt?.toISOString()).toBe(T1.toISOString());
    });

    it('fails when registration changed after the claimant observed the session', async () => {
      await setStatus('launching');

      await repo.markRuntimeRegistered(sessionId, T1);

      expect(await repo.expireStartingSession(sessionId, T2, {
        status: 'launching', runtimeRegisteredAt: null, firstPlacedAt: null,
      })).toBe(false);
      expect((await readSession()).status).toBe('launching');
    });

    it('fails when a heartbeat already made the session running', async () => {
      expect(await repo.markSessionRunning(sessionId, T1)).toBe(true);

      expect(await repo.expireStartingSession(sessionId, T2, {
        status: 'starting', runtimeRegisteredAt: null, firstPlacedAt: null,
      })).toBe(false);
      expect((await readSession()).status).toBe('running');
    });

    it('allows only one of two concurrent claims to succeed', async () => {
      const expected = { status: 'starting' as const, runtimeRegisteredAt: null, firstPlacedAt: null };

      const results = await Promise.all([
        repo.expireStartingSession(sessionId, T1, expected),
        repo.expireStartingSession(sessionId, T2, expected),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await readSession()).status).toBe('stopped');
    });
  });

  describe('stop is not resurrected', () => {
    it('keeps a stopped session stopped against late registration, placement, and heartbeat', async () => {
      await setStatus('launching');
      expect(await repo.expireStartingSession(sessionId, T1, {
        status: 'launching', runtimeRegisteredAt: null, firstPlacedAt: null,
      })).toBe(true);

      expect(await repo.markRuntimeRegistered(sessionId, T2)).toBe(false);
      expect(await repo.recordFirstPlacement(sessionId, T2, 'alloc-late')).toBe(false);
      expect(await repo.markSessionRunning(sessionId, T2)).toBe(false);

      const session = await readSession();
      expect(session.status).toBe('stopped');
      expect(session.runtimeRegisteredAt).toBeNull();
      expect(session.firstPlacedAt).toBeNull();
    });
  });
});
