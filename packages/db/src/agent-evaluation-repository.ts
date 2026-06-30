import crypto from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { agentEvaluations, agentRuntimeSessions } from './schema/index.js';
import type {
  EvaluationRunRequest,
  EvaluationRunRecord,
  EvaluationRunResult,
  EvaluationScope,
  ResolvedEvaluationScope,
  EvaluationRunStatus,
} from '@herobids/domain';

// ── Scope resolution ────────────────────────────────────────────────────────

/**
 * Error thrown when no session exists for the requested scope.
 * The API layer maps this to HTTP 404 (resource not found, not a bad request).
 */
export class NoSessionForScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSessionForScopeError';
  }
}

/**
 * Resolve `latestSession` to the most recent session for the agent.
 * Resolves to the most recently stopped session. Running sessions are not
 * evaluated — evaluation requires a completed session with start/end timestamps
 * for evidence filtering.
 *
 * Throws NoSessionForScopeError if no completed (stopped) session exists for
 * the agent.
 */
export async function resolveScope(
  db: Database,
  agentId: string,
  scope: EvaluationScope,
): Promise<ResolvedEvaluationScope> {
  if (scope.type === 'latestSession') {
    const [stopped] = await db
      .select({ id: agentRuntimeSessions.id })
      .from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, agentId),
        eq(agentRuntimeSessions.status, 'stopped'),
      ))
      .orderBy(desc(agentRuntimeSessions.stoppedAt))
      .limit(1);
    if (stopped) {
      return { type: 'session', sessionId: stopped.id };
    }

    throw new NoSessionForScopeError(
      `No completed session found for agent ${agentId}. ` +
      `Evaluation requires a stopped session with complete start/end timestamps. ` +
      `If the agent is currently running, stop it first, then evaluate.`,
    );
  }
  // Pass-through for concrete scopes
  return scope as ResolvedEvaluationScope;
}

/**
 * Derive a deterministic dedupe key from a resolved scope.
 * Only operates on `ResolvedEvaluationScope` — never sees `latestSession`.
 */
export function normalizeScopeKey(resolved: ResolvedEvaluationScope): string {
  switch (resolved.type) {
    case 'session':
      return `session:${resolved.sessionId}`;
    case 'timeRange':
      return `range:${resolved.from.toISOString()}-${resolved.to.toISOString()}`;
    case 'allTime':
      return 'allTime';
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Check if there is an active (queued or running) evaluation for the given
 * agent and scope key. Used for scope-aware deduplication.
 */
export async function hasActiveRunForScope(
  db: Database,
  agentId: string,
  scopeKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: agentEvaluations.id })
    .from(agentEvaluations)
    .where(and(
      eq(agentEvaluations.agentId, agentId),
      eq(agentEvaluations.scopeKey, scopeKey),
      sql`${agentEvaluations.status} IN ('queued', 'running')`,
    ))
    .limit(1);
  return !!row;
}

/**
 * Create a new evaluation run row atomically.
 *
 * Checks for an active run (queued/running) for the same agent + scope
 * within a transaction to prevent a TOCTOU race between the preflight
 * `hasActiveRunForScope` call in the API route and the INSERT here.
 *
 * Throws if an active run already exists for this agent + scope.
 */
export async function createRun(
  db: Database,
  request: EvaluationRunRequest,
  resolved: ResolvedEvaluationScope,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const scopeKey = normalizeScopeKey(resolved);

  await db.transaction(async (tx) => {
    // Re-check for active run inside the transaction to prevent races
    const [active] = await tx
      .select({ id: agentEvaluations.id })
      .from(agentEvaluations)
      .where(and(
        eq(agentEvaluations.agentId, request.agentId),
        eq(agentEvaluations.scopeKey, scopeKey),
        sql`${agentEvaluations.status} IN ('queued', 'running')`,
      ))
      .limit(1);

    if (active) {
      throw new Error(
        `An evaluation is already active for agent ${request.agentId} with scope ${scopeKey}.`,
      );
    }

    await tx.insert(agentEvaluations).values({
      id,
      agentId: request.agentId,
      status: 'queued',
      trigger: request.trigger,
      requestedScopeJson: request.scope as unknown as Record<string, unknown>,
      resolvedScopeJson: resolved as unknown as Record<string, unknown>,
      scopeKey,
      requestedByType: request.requester.type,
      requestedById: request.requester.type !== 'system' ? request.requester.id : null,
      attempt: 1,
    });
  });

  return { id };
}

/**
 * Transition a run to `running` status. Returns false if the run was not in `queued` status.
 */
export async function markRunning(db: Database, id: string): Promise<boolean> {
  await db
    .update(agentEvaluations)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(agentEvaluations.id, id), eq(agentEvaluations.status, 'queued')));
  // drizzle returns no row count; we check by re-reading
  const [row] = await db
    .select({ status: agentEvaluations.status })
    .from(agentEvaluations)
    .where(eq(agentEvaluations.id, id))
    .limit(1);
  return row?.status === 'running';
}

/**
 * Mark a run as succeeded with result data.
 * Only transitions from 'running' — silently no-ops if the run was already
 * reaped as timed_out, to prevent a late-finishing job from overwriting the
 * timeout status.
 */
export async function markSucceeded(
  db: Database,
  id: string,
  result: EvaluationRunResult,
): Promise<void> {
  await db
    .update(agentEvaluations)
    .set({
      status: 'succeeded',
      completedAt: new Date(),
      scorecardJson: result.scorecard as unknown as Record<string, unknown>,
      summaryJson: result.summary as unknown as Record<string, unknown>,
      artifactManifestJson: result.artifactManifest as unknown as Record<string, unknown>[],
    })
    .where(and(eq(agentEvaluations.id, id), eq(agentEvaluations.status, 'running')));
}

/**
 * Mark a run as failed with an error code and message.
 *
 * Only transitions from 'running' — if the run was already reaped as timed_out,
 * it stays timed_out to prevent a late-arriving failure from overwriting the timeout status.
 *
 * On failure, when the run has remaining retry attempts (attempt < maxAttempts),
 * the caller should use `markRetrying` instead to re-queue the run for BullMQ retry.
 */
export async function markFailed(
  db: Database,
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(agentEvaluations)
    .set({
      status: 'failed',
      failedAt: new Date(),
      errorCode,
      errorMessage,
    })
    .where(and(eq(agentEvaluations.id, id), eq(agentEvaluations.status, 'running')));
}

/**
 * Reset a run to 'queued' and increment its attempt counter for BullMQ retry.
 *
 * Called when a job fails but still has retry attempts remaining. The BullMQ
 * retry mechanism will re-deliver the job, which will then call `markRunning`
 * to transition queued → running.
 *
 * Only transitions from 'running' — a run reaped as timed_out stays timed_out.
 */
export async function markRetrying(
  db: Database,
  id: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(agentEvaluations)
    .set({
      status: 'queued',
      errorCode,
      errorMessage,
      startedAt: null,
      attempt: sql`${agentEvaluations.attempt} + 1`,
    })
    .where(and(eq(agentEvaluations.id, id), eq(agentEvaluations.status, 'running')));
}

/**
 * Mark a run as timed out.
 */
export async function markTimedOut(db: Database, id: string): Promise<void> {
  await db
    .update(agentEvaluations)
    .set({
      status: 'timed_out',
      timedOutAt: new Date(),
    })
    .where(eq(agentEvaluations.id, id));
}

/**
 * Fetch a single run by ID.
 */
export async function getRun(
  db: Database,
  id: string,
): Promise<EvaluationRunRecord | null> {
  const [row] = await db
    .select()
    .from(agentEvaluations)
    .where(eq(agentEvaluations.id, id))
    .limit(1);
  if (!row) return null;
  return toRunRecord(row);
}

/**
 * List runs for an agent, most recent first.
 */
export async function listByAgent(
  db: Database,
  agentId: string,
  opts?: { limit?: number; offset?: number },
): Promise<EvaluationRunRecord[]> {
  const rows = await db
    .select()
    .from(agentEvaluations)
    .where(eq(agentEvaluations.agentId, agentId))
    .orderBy(desc(agentEvaluations.requestedAt))
    .limit(opts?.limit ?? 50)
    .offset(opts?.offset ?? 0);
  return rows.map(toRunRecord);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type AgentEvaluationRow = typeof agentEvaluations.$inferSelect;

function toRunRecord(row: AgentEvaluationRow): EvaluationRunRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    status: row.status as EvaluationRunStatus,
    trigger: row.trigger as EvaluationRunRecord['trigger'],
    requestedScope: row.requestedScopeJson as unknown as EvaluationScope,
    resolvedScope: row.resolvedScopeJson as unknown as ResolvedEvaluationScope,
    scopeKey: row.scopeKey,
    requester: row.requestedByType === 'system'
      ? { type: 'system' }
      : { type: row.requestedByType as 'user' | 'agent', id: row.requestedById! },
    requestedAt: row.requestedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    failedAt: row.failedAt ?? undefined,
    timedOutAt: row.timedOutAt ?? undefined,
    attempt: row.attempt,
    result: row.scorecardJson
      ? {
          scorecard: row.scorecardJson as unknown as EvaluationRunResult['scorecard'],
          artifactManifest: (row.artifactManifestJson ?? []) as unknown as EvaluationRunResult['artifactManifest'],
          summary: row.summaryJson as unknown as EvaluationRunResult['summary'],
        }
      : undefined,
  };
}
