import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentRuntimeSessions } from '@herobids/db';
import { AGENT_STREAM_MAXLEN, MARKET_MONITOR_MESSAGE_TYPES } from '@herobids/domain';
import type { ExternalBackendClient, ExternalBackendClientResult, ExternalBackendSubject } from '@herobids/domain/external-backend';
import { errorPayload } from '../error-payload.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** POST body: the symbols + venue family to assess on the agent's behalf. */
const TriggerReviewBodySchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50),
  venueFamily: z.string().min(1),
});

/** A single per-symbol assessment result (mirrors traderton's assess_strategy_preset). */
interface AssessResult {
  success: boolean;
  symbol: string;
  canonicalIdentity?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  currentStrategy?: Record<string, unknown> | null;
  presets?: Array<Record<string, unknown>>;
  artifactId?: string;
  assessedAt?: string;
  expiresAt?: string;
  freshnessNote?: string;
  nextEligibleAt?: string;
  error?: string;
  errorCode?: string;
}

/** A strategy-change audit row (mirrors traderton's list_agent_strategy_changes). */
interface StrategyChange {
  id: string;
  ownerId: string;
  actorId: string;
  fromStrategy: Record<string, unknown> | null;
  toStrategy: Record<string, unknown>;
  artifactId: string;
  reason: string;
  state: string;
  createdAt: string;
  appliedAt: string | null;
}

export interface PlatformAssessmentReviewRouteConfig {
  /** The traderton boundary client (owner-scoped assess + read tools). */
  tradingBackendClient?: ExternalBackendClient;
  /** Per-request deadline for boundary calls. */
  tradingBackendTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Boundary helpers ────────────────────────────────────────────────────────

/** Invoke a traderton tool with the owner + agent subject. */
async function invokeBoundary(
  client: ExternalBackendClient | undefined,
  toolName: string,
  payload: Record<string, unknown>,
  subject: ExternalBackendSubject,
  deadlineMs: number,
): Promise<ExternalBackendClientResult> {
  if (!client) {
    return { kind: 'transport_error', requestId: '', retryable: true, message: 'trading boundary not configured' };
  }
  return client.invoke({ toolName, payload, subject, deadlineMs });
}

/** Map a non-success boundary result to an HTTP status + error payload. */
function boundaryError(result: ExternalBackendClientResult): { status: number; body: Record<string, unknown> } {
  switch (result.kind) {
    case 'failure': {
      const toolCode = result.details?.['errorCode'];
      const code = result.code === 'validation.invalid_payload' && typeof toolCode === 'string'
        ? toolCode
        : result.code;
      return { status: 502, body: errorPayload(code, result.message) };
    }
    case 'transport_error':
      return { status: 503, body: errorPayload('precondition.not_ready', 'Trading service is unavailable — the review could not be produced.') };
    case 'in_progress':
      return { status: 503, body: errorPayload('boundary.in_progress', 'The trading call did not complete in time. Please retry.') };
    default:
      return { status: 502, body: errorPayload('boundary.error', 'Unexpected boundary result') };
  }
}

/** Narrow a success payload's `results` array into assess results. */
function narrowAssessResults(payload: unknown): AssessResult[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return [];
  const results = (data as Record<string, unknown>)['results'];
  if (!Array.isArray(results)) return [];
  return results as AssessResult[];
}

/** Narrow a success payload's `changes` array into strategy-change rows. */
function narrowChanges(payload: unknown): StrategyChange[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as Record<string, unknown>)['data'];
  if (typeof data !== 'object' || data === null) return [];
  const changes = (data as Record<string, unknown>)['changes'];
  if (!Array.isArray(changes)) return [];
  return changes as StrategyChange[];
}

// ── Route module ────────────────────────────────────────────────────────────

/**
 * Platform assessment review API routes (H3 — data-only, free).
 *
 * The manual review no longer runs a billed platform assessment. It calls
 * traderton's `assess_strategy_preset` on the agent's behalf (owner-scoped),
 * then wakes the agent with the artifact ids. The review screen reads the
 * data-only artifacts + the agent's strategy-change history (decision + reason)
 * from traderton.
 *
 * - POST /agents/:id/platform-assessment/reviews — assess + wake (synchronous)
 * - GET  /agents/:id/platform-assessment/reviews/results — artifacts + changes
 * - GET  /agents/:id/platform-assessment/reviews/eligibility — trigger gating
 */
export async function platformAssessmentReviewRoutes(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
  config: PlatformAssessmentReviewRouteConfig,
): Promise<void> {
  const deadlineMs = config.tradingBackendTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ── POST /agents/:id/platform-assessment/reviews — assess + wake ───────

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/agents/:id/platform-assessment/reviews',
    async (request, reply) => {
      const { id: agentId } = request.params;
      const parsed = TriggerReviewBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

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

      // Gate: preset review is only meaningful for hybrid agents.
      if (unifiedConfig['capabilityMode'] !== 'hybrid') {
        return reply.status(403).send({
          error: 'capability_mode_unsupported',
          message: 'Strategy review is only available for hybrid agents',
        });
      }

      // Agent must have a running session
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
        return reply.status(409).send({
          error: 'no_active_session',
          message: 'The agent must have a running session to trigger a review',
        });
      }

      // Call traderton assess_strategy_preset on the agent's behalf (owner-scoped).
      const subject: ExternalBackendSubject = { ownerId: request.userId, actor: { type: 'agent', id: agentId } };
      const assessResult = await invokeBoundary(
        config.tradingBackendClient,
        'assess_strategy_preset',
        { symbols: parsed.data.symbols, venueFamily: parsed.data.venueFamily },
        subject,
        deadlineMs,
      );
      if (assessResult.kind !== 'success') {
        const err = boundaryError(assessResult);
        return reply.status(err.status).send(err.body);
      }

      const results = narrowAssessResults(assessResult.payload);

      // Wake the agent with the artifact ids so it can act on the assessment.
      const advice = results
        .filter((r) => r.success && r.artifactId && r.canonicalIdentity)
        .map((r, i) => ({
          identity: r.canonicalIdentity,
          candidateRank: i + 1,
          activePreset: (r.currentStrategy as Record<string, unknown> | null)?.presetKey ?? '',
          presetBehaviorVersion: (r.currentStrategy as Record<string, unknown> | null)?.behaviorVersion ?? '',
          reasons: ['Manual review requested by the creator'],
          assessmentArtifactId: r.artifactId,
          expiresAt: r.expiresAt,
        }));

      if (advice.length > 0) {
        const wakePayload = {
          wakeId: crypto.randomUUID(),
          reason: 'The creator requested a strategy review',
          eventIds: [],
          priority: 'normal',
          requestedAt: new Date().toISOString(),
          source: 'scanner',
          context: {
            scannerKind: 'assessment_review',
            advice,
            checkedAt: new Date().toISOString(),
            nextEligibleAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        };
        const envelope = {
          schemaVersion: 'v1',
          messageId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          initiatorType: 'system',
          initiatorId: agentId,
          agentId,
          type: MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE,
          createdAt: new Date().toISOString(),
          payload: wakePayload,
        };
        await redisClient.xadd(
          `agent:outbound:${agentId}`,
          'MAXLEN', '~', AGENT_STREAM_MAXLEN,
          '*',
          'envelope',
          JSON.stringify(envelope),
        );
      }

      return reply.status(202).send({
        requestId: crypto.randomUUID(),
        results,
      });
    },
  );

  // ── GET /agents/:id/platform-assessment/reviews/results ────────────────

  app.get<{ Params: { id: string } }>(
    '/agents/:id/platform-assessment/reviews/results',
    async (request, reply) => {
      const { id: agentId } = request.params;

      // Ownership check
      const [agent] = await db
        .select({ id: agents.id, userId: agents.userId })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const subject: ExternalBackendSubject = { ownerId: request.userId, actor: { type: 'agent', id: agentId } };

      // Read the agent's strategy-change history (decision + reason).
      const changesResult = await invokeBoundary(
        config.tradingBackendClient,
        'list_agent_strategy_changes',
        { actorId: agentId, limit: 50 },
        subject,
        deadlineMs,
      );
      if (changesResult.kind !== 'success') {
        const err = boundaryError(changesResult);
        return reply.status(err.status).send(err.body);
      }
      const changes = narrowChanges(changesResult.payload);

      return reply.send({ changes });
    },
  );

  // ── GET /agents/:id/platform-assessment/reviews/eligibility ────────────

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

      // Gate: preset review is only meaningful for hybrid agents
      if (unifiedConfig['capabilityMode'] !== 'hybrid') {
        reasons.push('Strategy review is only available for hybrid agents');
      }

      const canTrigger = reasons.length === 0;

      return reply.send({
        canTrigger,
        reason: canTrigger ? null : reasons.join('; '),
      });
    },
  );
}
