import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  agents,
  agentRuntimeSessions,
  createManualReviewRun,
  getManualReviewRun,
  hasActiveManualReviewRun,
} from '@herobids/db';
import type { ManualReviewJobData } from '@herobids/db';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PlatformAssessmentReviewRouteConfig {
  /** Operator-level platform assessor enabled flag */
  platformAssessorEnabled: boolean;
}

// ── Route module ────────────────────────────────────────────────────────────

/**
 * Platform assessment review API routes.
 *
 * Provides user-triggered forced strategy review for agents:
 * - POST   /agents/:id/platform-assessment/reviews        — trigger a manual review
 * - GET    /agents/:id/platform-assessment/reviews/:requestId — poll run status
 * - GET    /agents/:id/platform-assessment/reviews/eligibility — check if eligible
 */
export async function platformAssessmentReviewRoutes(
  app: FastifyInstance,
  queue: Queue<ManualReviewJobData>,
  db: Database,
  config: PlatformAssessmentReviewRouteConfig,
): Promise<void> {
  // ── POST /agents/:id/platform-assessment/reviews — trigger ───────────

  app.post<{ Params: { id: string } }>(
    '/agents/:id/platform-assessment/reviews',
    async (request, reply) => {
      const { id: agentId } = request.params;

      // Ownership check
      const [agent] = await db
        .select({
          id: agents.id,
          userId: agents.userId,
          status: agents.status,
          unifiedConfig: agents.unifiedConfig,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      // Operator-level feature gate
      if (!config.platformAssessorEnabled) {
        return reply.status(403).send({
          error: 'platform_assessor_disabled',
          message: 'Platform assessment is disabled at the operator level',
        });
      }

      // Agent-level opt-in check
      const unifiedConfig = (agent.unifiedConfig ?? {}) as Record<string, unknown>;
      const platformAssessment = (unifiedConfig['platformAssessment'] ?? {}) as Record<string, unknown>;
      if (platformAssessment['enabled'] !== true) {
        return reply.status(403).send({
          error: 'agent_not_opted_in',
          message: 'This agent has not enabled platform assessment',
        });
      }

      // Agent must be active
      if (agent.status !== 'active') {
        return reply.status(409).send({
          error: 'agent_not_active',
          message: 'The agent must be active to trigger a review',
        });
      }

      // Agent must have a running session
      const [activeSession] = await db
        .select({ id: agentRuntimeSessions.id, status: agentRuntimeSessions.status })
        .from(agentRuntimeSessions)
        .where(
          and(
            eq(agentRuntimeSessions.agentId, agentId),
            eq(agentRuntimeSessions.status, 'running'),
          ),
        )
        .limit(1);
      if (!activeSession) {
        return reply.status(409).send({
          error: 'no_active_session',
          message: 'The agent must have a running session to trigger a review',
        });
      }

      // No active (in-flight) manual review run
      const hasActive = await hasActiveManualReviewRun(db, agentId);
      if (hasActive) {
        return reply.status(409).send({
          error: 'review_already_in_progress',
          message: 'A manual review is already in progress for this agent',
        });
      }

      // Create run row and enqueue job
      const runId = crypto.randomUUID();
      await createManualReviewRun(db, {
        id: runId,
        agentId,
        requestedByUserId: request.userId,
      });

      await queue.add(`manual-review:${agentId}`, {
        runId,
        agentId,
        requestedByUserId: request.userId,
      } satisfies ManualReviewJobData);

      return reply.status(202).send({ requestId: runId });
    },
  );

  // ── GET /agents/:id/platform-assessment/reviews/:requestId — status ──

  app.get<{ Params: { id: string; requestId: string } }>(
    '/agents/:id/platform-assessment/reviews/:requestId',
    async (request, reply) => {
      const { id: agentId, requestId } = request.params;

      // Ownership check
      const [agent] = await db
        .select({ id: agents.id, userId: agents.userId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const run = await getManualReviewRun(db, requestId);
      if (!run) return reply.status(404).send({ error: 'not_found' });

      // Ensure the run belongs to the requested agent
      if (run.agentId !== agentId) {
        return reply.status(404).send({ error: 'not_found' });
      }

      return reply.send({
        requestId: run.id,
        status: run.status,
        trigger: run.trigger,
        requestedAt: run.requestedAt?.toISOString() ?? null,
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        resultSummary: run.resultSummary ?? null,
        errorCode: run.errorCode ?? null,
        errorMessage: run.errorMessage ?? null,
      });
    },
  );

  // ── GET /agents/:id/platform-assessment/reviews/eligibility ──────────

  app.get<{ Params: { id: string } }>(
    '/agents/:id/platform-assessment/reviews/eligibility',
    async (request, reply) => {
      const { id: agentId } = request.params;

      // Ownership check
      const [agent] = await db
        .select({
          id: agents.id,
          userId: agents.userId,
          status: agents.status,
          unifiedConfig: agents.unifiedConfig,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const reasons: string[] = [];

      // Operator-level feature gate
      if (!config.platformAssessorEnabled) {
        reasons.push('Platform assessment is disabled at the operator level');
      }

      // Agent-level opt-in
      const unifiedConfig = (agent.unifiedConfig ?? {}) as Record<string, unknown>;
      const platformAssessment = (unifiedConfig['platformAssessment'] ?? {}) as Record<string, unknown>;
      if (platformAssessment['enabled'] !== true) {
        reasons.push('Platform assessment is not enabled for this agent');
      }

      // Agent must be active
      if (agent.status !== 'active') {
        reasons.push('Agent is not active');
      }

      // Running session check
      const [activeSession] = await db
        .select({ id: agentRuntimeSessions.id })
        .from(agentRuntimeSessions)
        .where(
          and(
            eq(agentRuntimeSessions.agentId, agentId),
            eq(agentRuntimeSessions.status, 'running'),
          ),
        )
        .limit(1);
      if (!activeSession) {
        reasons.push('No active runtime session');
      }

      // No in-flight run
      const hasActive = await hasActiveManualReviewRun(db, agentId);
      if (hasActive) {
        reasons.push('A manual review is already in progress');
      }

      const canTrigger = reasons.length === 0;

      return reply.send({
        canTrigger,
        reason: canTrigger ? null : reasons.join('; '),
      });
    },
  );
}
