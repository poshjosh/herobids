import { eq, and, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentAssessmentReviewRuns } from './schema/index.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ManualReviewRunRow {
  id: string;
  agentId: string;
  requestedByUserId: string;
  status: string;
  trigger: string;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  checkId: string | null;
  resultSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface ManualReviewResultSummary {
  hasAdvice: boolean;
  advisedCount: number;
  outcomeCounts: Record<string, number>;
  checkOutcome: string | null;
  checkedAt: string;
  nextEligibleAt: string;
  checkId: string;
  assessmentStatus?: 'not_applicable' | 'assessing' | 'completed';
  assessedCount?: number;
  totalAdvised?: number;
  capacityExceeded?: boolean;
}

// ── Repository helpers ──────────────────────────────────────────────────────

/**
 * Create a new manual review run row in `queued` status.
 * Returns the created row ID.
 */
export async function createManualReviewRun(
  db: Database,
  params: { id: string; agentId: string; requestedByUserId: string },
): Promise<string> {
  await db.insert(agentAssessmentReviewRuns).values({
    id: params.id,
    agentId: params.agentId,
    requestedByUserId: params.requestedByUserId,
    status: 'queued',
    trigger: 'manual_frontend',
    requestedAt: new Date(),
  });
  return params.id;
}

/**
 * Mark a manual review run as `running`.
 * Returns true if the transition succeeded (was queued → running), false otherwise.
 */
export async function markManualReviewRunning(
  db: Database,
  runId: string,
): Promise<boolean> {
  const result = await db
    .update(agentAssessmentReviewRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(
      and(
        eq(agentAssessmentReviewRuns.id, runId),
        eq(agentAssessmentReviewRuns.status, 'queued'),
      ),
    );
  return result.count > 0;
}

/**
 * Mark a manual review run as `succeeded` with a result summary.
 */
export async function markManualReviewSucceeded(
  db: Database,
  runId: string,
  resultSummary: ManualReviewResultSummary,
): Promise<void> {
  await db
    .update(agentAssessmentReviewRuns)
    .set({
      status: 'succeeded',
      completedAt: new Date(),
      checkId: resultSummary.checkId,
      resultSummary: resultSummary as unknown as Record<string, unknown>,
    })
    .where(eq(agentAssessmentReviewRuns.id, runId));
}

/**
 * Mark a manual review run as `failed` with error details.
 */
export async function markManualReviewFailed(
  db: Database,
  runId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(agentAssessmentReviewRuns)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorCode,
      errorMessage,
    })
    .where(eq(agentAssessmentReviewRuns.id, runId));
}

/**
 * Fetch a single manual review run by ID.
 */
export async function getManualReviewRun(
  db: Database,
  runId: string,
): Promise<ManualReviewRunRow | undefined> {
  const [row] = await db
    .select()
    .from(agentAssessmentReviewRuns)
    .where(eq(agentAssessmentReviewRuns.id, runId))
    .limit(1);
  return row;
}

/**
 * Fetch the latest manual review run for an agent (any status).
 */
export async function getLatestManualReviewRun(
  db: Database,
  agentId: string,
): Promise<ManualReviewRunRow | undefined> {
  const [row] = await db
    .select()
    .from(agentAssessmentReviewRuns)
    .where(eq(agentAssessmentReviewRuns.agentId, agentId))
    .orderBy(sql`${agentAssessmentReviewRuns.requestedAt} DESC`)
    .limit(1);
  return row;
}

/**
 * Check if there is an active (non-terminal) manual review run for the agent.
 * Active means status is 'queued' or 'running'.
 */
export async function hasActiveManualReviewRun(
  db: Database,
  agentId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentAssessmentReviewRuns.id })
    .from(agentAssessmentReviewRuns)
    .where(
      and(
        eq(agentAssessmentReviewRuns.agentId, agentId),
        sql`${agentAssessmentReviewRuns.status} IN ('queued', 'running')`,
      ),
    )
    .limit(1);
  return !!row;
}
