import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { Queue } from 'bullmq';
import type { Database } from '@herobids/db';
import {
  agents,
  resolveScope,
  normalizeScopeKey,
  hasActiveRunForScope,
  createRun,
  getRun,
  listByAgent,
  FsEvaluationArtifactStore,
  AgentRepository,
} from '@herobids/db';
import type { EvaluationJobData, ResolvedNarrativeLlmConfig } from '@herobids/db';
import type { EvaluationScope, EvaluationTrigger, ProvidersYaml } from '@herobids/domain';
import type { OperatorLlmCatalogContext } from '../llm-model-catalog.js';
import { resolveNarrativeLlmConfig } from './agent-evaluation-narrative-llm.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

const NarrativeLlmSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1),
});

const TriggerEvaluationSchema = z.object({
  scope: z.object({
    type: z.enum(['session', 'latestSession', 'timeRange', 'allTime']),
    sessionId: z.string().optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).optional().default({ type: 'latestSession' }),
  includeNarrative: z.boolean().optional().default(false),
  narrativeLlm: NarrativeLlmSchema.optional(),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ── Scope parsing ───────────────────────────────────────────────────────────

function parseScope(raw: z.infer<typeof TriggerEvaluationSchema>['scope']): EvaluationScope {
  switch (raw.type) {
    case 'session':
      if (!raw.sessionId) throw new Error('sessionId is required for session scope');
      return { type: 'session', sessionId: raw.sessionId };
    case 'latestSession':
      return { type: 'latestSession' };
    case 'timeRange':
      if (!raw.from || !raw.to) throw new Error('from and to are required for timeRange scope');
      return { type: 'timeRange', from: new Date(raw.from), to: new Date(raw.to) };
    case 'allTime':
      return { type: 'allTime' };
  }
}

// ── Route module ────────────────────────────────────────────────────────────

export interface EvaluationRouteConfig {
  /** Root directory for evaluation artifacts */
  storageRoot: string;
  /** Max wall-clock time per evaluation run in ms (job timeout). */
  maxRuntimeMs: number;
  /** Max retry attempts for failed evaluation jobs. */
  maxAttempts: number;
}

export interface NarrativeLlmDeps {
  /** Operator default LLM provider */
  provider: string;
  /** Operator default LLM base URL */
  baseUrl?: string;
  /** LLM call timeout for narrative generation */
  timeoutMs: number;
  /** Max tokens for narrative generation */
  maxTokens: number;
  /** Provider registry for model validation */
  providersYaml: ProvidersYaml;
  /** Catalog discovery timeout (for dynamic provider model validation) */
  catalogTimeoutMs: number;
  /** Catalog cache TTL (for dynamic provider model validation) */
  catalogCacheTtlMs: number;
  /** Catalog locality policy (for dynamic provider model validation) */
  catalogLocality: OperatorLlmCatalogContext['catalogLocality'];
}

/**
 * Agent evaluation API routes.
 *
 * Dependencies:
 * - `queue`: BullMQ Queue for enqueuing evaluation jobs.
 * - `db`: Database handle.
 * - `evalConfig`: Evaluation timeout/retry settings from operator config.
 */
export async function agentEvaluationRoutes(
  app: FastifyInstance,
  queue: Queue<EvaluationJobData>,
  db: Database,
  evalConfig: EvaluationRouteConfig,
  narrativeLlmDeps: NarrativeLlmDeps,
): Promise<void> {
  const store = new FsEvaluationArtifactStore(evalConfig.storageRoot);
  const agentRepo = new AgentRepository(db, narrativeLlmDeps.providersYaml);

  // ── POST /agents/:id/evaluations — trigger evaluation ──────────────────

  app.post<{ Params: { id: string } }>(
    '/agents/:id/evaluations',
    async (request, reply) => {
      const { id } = request.params;

      // Ownership check
      const [agent] = await db
        .select({ id: agents.id, userId: agents.userId })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      // Parse and validate scope
      const parsed = TriggerEvaluationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      let scope: EvaluationScope;
      try {
        scope = parseScope(parsed.data.scope);
      } catch (err) {
        return reply.status(400).send({ error: 'validation_error', message: (err as Error).message });
      }

      // `allTime` requires explicit opt-in via query parameter
      if (scope.type === 'allTime') {
        const allowAllTime = (request.query as Record<string, string> | undefined)?.['allowAllTime'] === 'true';
        if (!allowAllTime) {
          return reply.status(400).send({
            error: 'validation_error',
            message: 'allTime scope requires explicit operator approval. Set ?allowAllTime=true to opt in.',
          });
        }
      }

      // Validate narrativeLlm constraints (parsed.success guaranteed by early return above)
      const { includeNarrative, narrativeLlm } = parsed.data;
      if (!includeNarrative && narrativeLlm) {
        return reply.status(400).send({
          error: 'validation_error',
          message: 'narrativeLlm must not be provided when includeNarrative is false',
        });
      }

      // Resolve narrative LLM configuration at enqueue time
      let resolvedNarrativeLlm: ResolvedNarrativeLlmConfig | undefined;
      if (includeNarrative) {
        try {
          // Read agent model policy
          const [agentRow] = await db
            .select({ modelPolicy: agents.modelPolicy, userId: agents.userId })
            .from(agents)
            .where(eq(agents.id, id))
            .limit(1);

          // Read user AI model config
          const userAiConfig = await agentRepo.getUserAiModelConfig(agentRow?.userId ?? request.userId);

          resolvedNarrativeLlm = await resolveNarrativeLlmConfig({
            agentModelPolicy: (agentRow?.modelPolicy as Record<string, unknown>) ?? null,
            userAiModelConfig: userAiConfig,
            narrativeLlmOverride: narrativeLlm,
            operatorDefaultProvider: narrativeLlmDeps.provider,
            operatorBaseUrl: narrativeLlmDeps.baseUrl,
            operatorTimeoutMs: narrativeLlmDeps.timeoutMs,
            operatorMaxTokens: narrativeLlmDeps.maxTokens,
            providersYaml: narrativeLlmDeps.providersYaml,
            catalogDeps: {
              db,
              providersYaml: narrativeLlmDeps.providersYaml,
              context: {
                provider: narrativeLlmDeps.provider,
                model: '', // not used for model validation — only needed for Ollama fallback
                baseUrl: narrativeLlmDeps.baseUrl,
                catalogTimeoutMs: narrativeLlmDeps.catalogTimeoutMs,
                catalogCacheTtlMs: narrativeLlmDeps.catalogCacheTtlMs,
                catalogLocality: narrativeLlmDeps.catalogLocality,
              },
            },
          });
        } catch (err) {
          return reply.status(400).send({
            error: 'narrative_llm_resolution_failed',
            message: (err as Error).message,
          });
        }
      }

      // Resolve scope (expands latestSession → concrete session)
      let resolved: Awaited<ReturnType<typeof resolveScope>>;
      try {
        resolved = await resolveScope(db, id, scope);
      } catch (err) {
        return reply.status(404).send({
          error: 'scope_resolution_failed',
          message: (err as Error).message,
        });
      }

      // Scope-aware dedupe
      const scopeKey = normalizeScopeKey(resolved);
      const active = await hasActiveRunForScope(db, id, scopeKey);
      if (active) {
        return reply.status(409).send({
          error: 'conflict',
          message: `An evaluation is already running for agent ${id} with scope ${scopeKey}.`,
        });
      }

      // Create run (atomic — the repository re-checks for duplicates inside
      // a transaction to close the TOCTOU window between the preflight check
      // above and the actual INSERT)
      const trigger: EvaluationTrigger = 'manual';
      let runId: string;
      try {
        ({ id: runId } = await createRun(
          db,
          {
            agentId: id,
            scope,
            trigger,
            requester: { type: 'user', id: request.userId },
            includeNarrative: parsed.data.includeNarrative,
          },
          resolved,
        ));
      } catch (err) {
        if ((err as Error).message?.includes('already active')) {
          return reply.status(409).send({
            error: 'conflict',
            message: (err as Error).message,
          });
        }
        throw err;
      }

      // Enqueue job with timeout and retry settings from operator config
      await queue.add(`eval-${runId}`, {
        runId,
        agentId: id,
        resolvedScope: resolved,
        includeNarrative: parsed.data.includeNarrative,
        narrativeLlm: resolvedNarrativeLlm,
      }, {
        attempts: evalConfig.maxAttempts,
        backoff: { type: 'exponential', delay: 5000 },
      } as Record<string, unknown>);

      return reply.status(202).send({ runId });
    },
  );

  // ── GET /agents/:id/evaluations — list runs ─────────────────────────────

  app.get<{ Params: { id: string }; Querystring: z.infer<typeof ListQuerySchema> }>(
    '/agents/:id/evaluations',
    async (request, reply) => {
      const { id } = request.params;

      // Ownership check
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const parsed = ListQuerySchema.safeParse(request.query);
      const { limit, offset } = parsed.success ? parsed.data : { limit: 50, offset: 0 };

      const runs = await listByAgent(db, id, { limit, offset });
      return reply.send(runs);
    },
  );

  // ── GET /agents/:id/evaluations/:runId — get run status ─────────────────

  app.get<{ Params: { id: string; runId: string } }>(
    '/agents/:id/evaluations/:runId',
    async (request, reply) => {
      const { id, runId } = request.params;

      // Ownership check
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const run = await getRun(db, runId);
      if (!run || run.agentId !== id) return reply.status(404).send({ error: 'not_found' });

      return reply.send(run);
    },
  );

  // ── GET /agents/:id/evaluations/:runId/artifacts — list artifacts ───────

  app.get<{ Params: { id: string; runId: string } }>(
    '/agents/:id/evaluations/:runId/artifacts',
    async (request, reply) => {
      const { id, runId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const run = await getRun(db, runId);
      if (!run || run.agentId !== id) return reply.status(404).send({ error: 'not_found' });

      const artifacts = await store.list(runId);
      return reply.send(artifacts);
    },
  );

  // ── GET /agents/:id/evaluations/:runId/artifacts/:name — download ───────

  app.get<{ Params: { id: string; runId: string; name: string } }>(
    '/agents/:id/evaluations/:runId/artifacts/:name',
    async (request, reply) => {
      const { id, runId, name } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      const run = await getRun(db, runId);
      if (!run || run.agentId !== id) return reply.status(404).send({ error: 'not_found' });

      // Resolve MIME type from the persisted artifact manifest
      const artifactEntry = run.result?.artifactManifest?.find((a) => a.name === name);
      const contentType = artifactEntry?.mimeType ?? 'application/octet-stream';

      const data = await store.read(runId, name);
      if (!data) return reply.status(404).send({ error: 'not_found', message: `Artifact '${name}' not found` });

      void reply.header('Content-Type', contentType);
      void reply.header('Content-Disposition', `attachment; filename="${name}"`);
      return reply.send(Buffer.from(data));
    },
  );
}
