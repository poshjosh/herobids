import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '@herobids/db';
import {
  createManualReviewRun,
  markManualReviewRunning,
  markManualReviewSucceeded,
  markManualReviewFailed,
  getManualReviewRun,
  getLatestManualReviewRun,
  hasActiveManualReviewRun,
} from '@herobids/db';
import type { ManualReviewResultSummary } from '@herobids/db';
import crypto from 'node:crypto';

// These tests require a running Postgres instance (e.g., docker compose up -d).
// They use the same test DB URL pattern as other integration tests.
const DB_URL = process.env['TEST_DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/herobids_test';
const SKIP = !process.env['TEST_DATABASE_URL'] && !process.env['DATABASE_URL'];

describe.skipIf(SKIP)('ManualReviewRepository', () => {
  const db = createDatabase(DB_URL);
  const agentId = `test-agent-${crypto.randomUUID().slice(0, 8)}`;
  const userId = `test-user-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // Seed minimal agent and user rows so FK constraints are satisfied
    await db.execute(`INSERT INTO users (id, username, email, display_name, created_at, updated_at) 
      VALUES ('${userId}', 'testuser', 'test@test.com', 'Test User', NOW(), NOW()) 
      ON CONFLICT (id) DO NOTHING`);
    await db.execute(`INSERT INTO agents (id, user_id, name, prompt, status, created_at, updated_at) 
      VALUES ('${agentId}', '${userId}', 'Test Agent', 'test', 'active', NOW(), NOW()) 
      ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    await db.execute(`DELETE FROM agent_assessment_review_runs WHERE agent_id = '${agentId}'`);
    await db.execute(`DELETE FROM agents WHERE id = '${agentId}'`);
    await db.execute(`DELETE FROM users WHERE id = '${userId}'`);
  });

  describe('createManualReviewRun', () => {
    it('creates a new manual review run in queued status', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });

      const run = await getManualReviewRun(db, runId);
      expect(run).toBeDefined();
      expect(run!.status).toBe('queued');
      expect(run!.agentId).toBe(agentId);
      expect(run!.requestedByUserId).toBe(userId);
      expect(run!.trigger).toBe('manual_frontend');
    });
  });

  describe('markManualReviewRunning', () => {
    it('transitions queued → running and sets startedAt', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });

      const result = await markManualReviewRunning(db, runId);
      expect(result).toBe(true);

      const run = await getManualReviewRun(db, runId);
      expect(run!.status).toBe('running');
      expect(run!.startedAt).toBeDefined();
    });

    it('returns false when run is not in queued status', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });
      await markManualReviewRunning(db, runId);

      // Second call should fail because it's already running
      const result = await markManualReviewRunning(db, runId);
      expect(result).toBe(false);
    });
  });

  describe('markManualReviewSucceeded', () => {
    it('persists terminal success with result summary', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });
      await markManualReviewRunning(db, runId);

      const summary: ManualReviewResultSummary = {
        hasAdvice: true,
        advisedCount: 3,
        outcomeCounts: { advised: 3, not_advised: 1 },
        checkOutcome: 'advised',
        checkedAt: new Date().toISOString(),
        nextEligibleAt: new Date(Date.now() + 86_400_000).toISOString(),
        checkId: crypto.randomUUID(),
      };

      await markManualReviewSucceeded(db, runId, summary);

      const run = await getManualReviewRun(db, runId);
      expect(run!.status).toBe('succeeded');
      expect(run!.completedAt).toBeDefined();
      expect(run!.checkId).toBe(summary.checkId);
      expect(run!.resultSummary).toEqual(summary);
    });
  });

  describe('markManualReviewFailed', () => {
    it('persists terminal failure with error details', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });
      await markManualReviewRunning(db, runId);

      await markManualReviewFailed(db, runId, 'review.timeout', 'Timed out');

      const run = await getManualReviewRun(db, runId);
      expect(run!.status).toBe('failed');
      expect(run!.completedAt).toBeDefined();
      expect(run!.errorCode).toBe('review.timeout');
      expect(run!.errorMessage).toBe('Timed out');
    });
  });

  describe('hasActiveManualReviewRun', () => {
    it('returns true when a queued run exists', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });

      const hasActive = await hasActiveManualReviewRun(db, agentId);
      expect(hasActive).toBe(true);
    });

    it('returns true when a running run exists', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });
      await markManualReviewRunning(db, runId);

      const hasActive = await hasActiveManualReviewRun(db, agentId);
      expect(hasActive).toBe(true);
    });

    it('returns false when only terminal runs exist', async () => {
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId, agentId, requestedByUserId: userId });
      await markManualReviewRunning(db, runId);
      await markManualReviewSucceeded(db, runId, {
        hasAdvice: false,
        advisedCount: 0,
        outcomeCounts: { no_candidate: 1 },
        checkOutcome: 'no_candidate',
        checkedAt: new Date().toISOString(),
        nextEligibleAt: new Date(Date.now() + 86_400_000).toISOString(),
        checkId: crypto.randomUUID(),
      });

      const hasActive = await hasActiveManualReviewRun(db, agentId);
      expect(hasActive).toBe(false);
    });
  });

  describe('getLatestManualReviewRun', () => {
    it('returns the most recently requested run', async () => {
      const runId1 = crypto.randomUUID();
      const runId2 = crypto.randomUUID();
      await createManualReviewRun(db, { id: runId1, agentId, requestedByUserId: userId });
      // Small delay to ensure ordering
      await new Promise((r) => setTimeout(r, 10));
      await createManualReviewRun(db, { id: runId2, agentId, requestedByUserId: userId });

      const latest = await getLatestManualReviewRun(db, agentId);
      expect(latest).toBeDefined();
      expect(latest!.id).toBe(runId2);
    });
  });
});
