import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, sql, desc, asc, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  blueprints,
  blueprintRevisions,
  blueprintRevisionSkills,
  blueprintInstantiationRequests,
  blueprintForkRequests,
  blueprintUsageEvents,
  blueprintLikes,
  bots,
  agents,
  agentSkills,
  connections,
  venueAccounts,
} from '@herobids/db';
import {
  applyPresetToAgent,
  BlueprintErrorCodes,
  BlueprintInstantiatePreviewRequestSchema,
  BlueprintInstantiatePreviewResponseSchema,
  BlueprintInstantiateRequestSchema,
  PublishBlueprintSchema,
  BlueprintBrowseQuerySchema,
  BlueprintForkRequestSchema,
  BlueprintSummarySchema,
  BlueprintDetailSchema,
  BlueprintRevisionSummarySchema,
  CreateBlueprintSchema,
  CreateBlueprintRevisionSchema,
  encodeBlueprintCursor,
  decodeBlueprintCursor,
} from '@herobids/domain';
import type {
  AgentRiskDefaultsConfig,
  BlueprintExecutionCapabilityResolver,
  BlueprintExecutionCapabilityInput,
  AgentBlueprintRevisionPayload,
  BotBlueprintRevisionPayload,
  PlansConfig,
} from '@herobids/domain';
import { listPresets, getPreset } from '@herobids/domain/config/presets-loader';
import { resolvePlanBlueprintEntitlements } from '../plan-guards.js';
import { computeInstantiateRequestHash } from '../services/blueprint-idempotency.js';
import { resolveEffectiveRisk } from '../services/blueprint-risk-resolver.js';
import { validateSkillPortability } from '../services/blueprint-skill-validator.js';
import {
  recomputeBlueprintScores,
  refreshLikeCount,
  refreshForkCount,
} from '../services/blueprint-scoring.js';
import { recomputeBlueprintPerformanceScore } from '../services/blueprint-performance-scorer.js';

// --- Request schemas ---

const StyleQuerySchema = z.object({
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
});

const ForAgentQuerySchema = z.object({
  strategy: z.string().min(1),
  style: z.enum(['economy', 'standard', 'premium']).default('standard'),
  mode: z.enum(['llm', 'hybrid']).default('llm'),
});

// --- Helper ---

/**
 * TODO (Phase 1 Milestone B): Reimplement when legacy CRUD routes are rewritten
 * for the new schema (authorId, publicationStatus, revision payload).
 *
 * Returns the blueprint if the authenticated user owns it, or if it is public.
 */
// async function resolveBlueprintForRead(
//   db: Database,
//   id: string,
//   userId: string,
// ): Promise<typeof blueprints.$inferSelect | null> {
//   const [bp] = await db.select().from(blueprints)
//     .where(and(
//       eq(blueprints.id, id),
//       or(eq(blueprints.userId, userId), eq(blueprints.visibility, 'public')),
//     ));
//   return bp ?? null;
// }

/**
 * TODO (Phase 1 Milestone B): Reimplement when legacy CRUD routes are rewritten.
 *
 * Returns the blueprint only if the authenticated user owns it (for mutations).
 */
// async function resolveBlueprintForWrite(
//   db: Database,
//   id: string,
//   userId: string,
// ): Promise<typeof blueprints.$inferSelect | null> {
//   const [bp] = await db.select().from(blueprints)
//     .where(and(eq(blueprints.id, id), eq(blueprints.userId, userId)));
//   return bp ?? null;
// }

// --- Helpers for new blueprint system ---

/**
 * Resolve the targeted revision for a blueprint access check.
 * Owners/admins can access any revision; nonowners only get publishedRevisionId.
 */
async function resolveTargetRevision(
  db: Database,
  blueprintId: string,
  requestedRevisionId: string | undefined,
  userId: string,
  isAdmin: boolean,
): Promise<{ blueprint: typeof blueprints.$inferSelect; revision: typeof blueprintRevisions.$inferSelect } | { error: string; code: string }> {
  const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, blueprintId));
  if (!bp) return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };

  const isOwner = bp.authorId === userId;

  // Delisted/archived → all new operations blocked
  if (bp.publicationStatus === 'delisted' || bp.publicationStatus === 'archived') {
    if (!isOwner && !isAdmin) return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
    return { error: 'Blueprint is delisted or archived', code: BlueprintErrorCodes.LIFECYCLE_CONFLICT };
  }

  // Nonowners can only access published blueprints
  if (!isOwner && !isAdmin && bp.publicationStatus !== 'published') {
    return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
  }

  // Resolve the revision to use
  let revisionId: string;
  if (requestedRevisionId) {
    // Owner/admin can pick any revision; nonowner gets only publishedRevisionId
    if (!isOwner && !isAdmin) {
      if (requestedRevisionId !== bp.publishedRevisionId) {
        return { error: 'Blueprint not found', code: BlueprintErrorCodes.NOT_FOUND };
      }
    }
    revisionId = requestedRevisionId;
  } else {
    // No revision specified: nonowners get published, owners get current
    if (!isOwner && !isAdmin) {
      if (!bp.publishedRevisionId) {
        return { error: 'Blueprint not published', code: BlueprintErrorCodes.NOT_FOUND };
      }
      revisionId = bp.publishedRevisionId;
    } else {
      if (!bp.currentRevisionId) {
        return { error: 'Blueprint has no revision', code: BlueprintErrorCodes.NOT_FOUND };
      }
      revisionId = bp.currentRevisionId;
    }
  }

  const [revision] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, revisionId));
  if (!revision) return { error: 'Revision not found', code: BlueprintErrorCodes.NOT_FOUND };
  if (revision.blueprintId !== blueprintId) {
    return { error: 'Revision does not belong to this blueprint', code: BlueprintErrorCodes.VALIDATION };
  }

  return { blueprint: bp, revision };
}

/**
 * Determine if a blueprint revision represents a trading-capable agent.
 * Trading-capable means: the agent has a strategy set (non-null) and
 * executionDefaults set (non-null).
 */
function isTradingCapable(payload: Record<string, unknown>): boolean {
  return payload.strategy != null && payload.executionDefaults != null;
}

/**
 * Extract skill refs from the blueprint revision's associated skills.
 */
export async function getRevisionSkillRefs(
  db: Database,
  revisionId: string,
): Promise<Array<{ skillId: string; skillRevisionId: string }>> {
  const rows = await db
    .select({
      skillId: blueprintRevisionSkills.skillId,
      skillRevisionId: blueprintRevisionSkills.skillRevisionId,
    })
    .from(blueprintRevisionSkills)
    .where(eq(blueprintRevisionSkills.blueprintRevisionId, revisionId))
    .orderBy(blueprintRevisionSkills.orderIndex);
  return rows;
}

/**
 * Fields whose values are nested objects and should be deep-merged
 * when applying installer edits, rather than shallow-replaced.
 */
const DEEP_MERGE_FIELDS = new Set([
  'risk',
  'executionPolicy',
  'executionDefaults',
  'runtimePolicyOverrides',
  'tokenSafety',
  'toolPolicy',
  'modelPolicy',
  'allowedPresets',
  'presetTransition',
  'platformAssessment',
  'wakePreferences',
]);

/**
 * Type predicate: narrows unknown to a plain (non-array) object.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge installer edits into a base payload.
 * For fields in DEEP_MERGE_FIELDS, merges the edit object into the base object
 * (installer fields override, other base fields preserved).
 * For all other fields, shallow-replaces with the edit value.
 */
function deepMergeEdits(
  basePayload: Record<string, unknown>,
  edits: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...basePayload };
  for (const key of Object.keys(edits)) {
    if (key === 'kind') continue; // kind is immutable
    const editVal = edits[key];
    if (editVal === undefined) continue;

    if (
      DEEP_MERGE_FIELDS.has(key) &&
      isPlainObject(editVal) &&
      isPlainObject(result[key])
    ) {
      // Deep merge: installer fields override, other base fields preserved
      result[key] = { ...result[key], ...editVal };
    } else {
      result[key] = editVal;
    }
  }
  return result;
}

// --- Lifecycle transition helpers ---

/**
 * Allowed lifecycle transitions per the plan.
 * Editing does not itself change lifecycle status.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['private', 'published', 'archived'],
  private: ['draft', 'published', 'archived'],
  published: ['published', 'delisted', 'archived'],
  delisted: ['published', 'archived'],
  archived: [],
};

function isAllowedTransition(from: string, to: string): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Response builders ---

interface BlueprintLineageInfo {
  sourceBlueprintId: string | null;
  sourceBlueprintRevisionId: string | null;
}

export async function buildBlueprintDetail(
  db: Database,
  bp: typeof blueprints.$inferSelect,
  revision: typeof blueprintRevisions.$inferSelect,
  lineageOverride?: BlueprintLineageInfo,
  isLikedByViewer = false,
): Promise<z.infer<typeof BlueprintDetailSchema>> {
  const skillRefs = await getRevisionSkillRefs(db, revision.id);

  const lineage = lineageOverride
    ? { sourceBlueprintId: lineageOverride.sourceBlueprintId, sourceBlueprintRevisionId: lineageOverride.sourceBlueprintRevisionId }
    : (bp.sourceBlueprintId
      ? { sourceBlueprintId: bp.sourceBlueprintId, sourceBlueprintRevisionId: bp.sourceBlueprintRevisionId }
      : null);

  return BlueprintDetailSchema.parse({
    id: bp.id,
    authorId: bp.authorId,
    publicationStatus: bp.publicationStatus,
    kind: bp.kind,
    name: revision.name,
    description: revision.description,
    tags: revision.tags,
    strategyType: revision.strategyType,
    style: revision.style,
    venueType: revision.venueType,
    likeCount: bp.likeCount,
    forkCount: bp.forkCount,
    isLikedByViewer,
    popularityScore: bp.popularityScore,
    trendingScore: bp.trendingScore,
    performanceScore: bp.performanceScore,
    publishedAt: bp.publishedAt?.toISOString() ?? null,
    currentRevisionId: bp.currentRevisionId,
    publishedRevisionId: bp.publishedRevisionId,
    sourceBlueprintId: bp.sourceBlueprintId,
    createdAt: bp.createdAt.toISOString(),
    updatedAt: bp.updatedAt.toISOString(),
    revision: {
      id: revision.id,
      blueprintId: revision.blueprintId,
      version: revision.version,
      kind: revision.kind,
      name: revision.name,
      description: revision.description,
      strategyType: revision.strategyType,
      style: revision.style,
      tags: revision.tags,
      venueType: revision.venueType,
      changeSummary: revision.changeSummary,
      createdByUserId: revision.createdByUserId,
      createdAt: revision.createdAt.toISOString(),
      payload: revision.payload as z.infer<typeof BlueprintDetailSchema>['revision']['payload'],
      skills: skillRefs,
    },
    lineage,
  });
}

// --- Compute fork request hash ---

function computeForkRequestHash(params: {
  sourceBlueprintId: string;
  sourceBlueprintRevisionId: string;
  edits?: Record<string, unknown> | null;
}): string {
  return computeInstantiateRequestHash({
    operation: 'fork',
    blueprintId: params.sourceBlueprintId,
    revisionId: params.sourceBlueprintRevisionId,
    kind: 'fork',
    edits: params.edits,
  });
}

// --- Route module ---

export async function blueprintRoutes(
  app: FastifyInstance,
  db: Database,
  agentRiskDefaults: AgentRiskDefaultsConfig,
  executionCapabilityResolver: BlueprintExecutionCapabilityResolver,
  plansConfig: PlansConfig,
): Promise<void> {
  // Periodic score recomputation (matches skills.ts pattern)
  const scoreRefreshTimer = setInterval(() => {
    void (async () => {
      try {
        const rows = await db.select({ id: blueprints.id }).from(blueprints);
        for (const row of rows) {
          await refreshLikeCount(db, row.id);
          await refreshForkCount(db, row.id);
          await recomputeBlueprintScores(db, row.id);
        }
      } catch (error: unknown) {
        app.log.error({ err: error }, '[blueprints] failed periodic score recomputation');
      }
    })();
  }, 60 * 60 * 1000);
  app.addHook('onClose', async () => {
    clearInterval(scoreRefreshTimer);
  });

  // Periodic performance score recomputation (nightly cadence — every 6 hours).
  // Performance scores are based on trading data which changes slowly.
  // Recompute for published blueprints only.
  const performanceRefreshTimer = setInterval(() => {
    void (async () => {
      try {
        const rows = await db
          .select({ id: blueprints.id })
          .from(blueprints)
          .where(eq(blueprints.publicationStatus, 'published'));
        for (const row of rows) {
          await recomputeBlueprintPerformanceScore(db, row.id);
        }
      } catch (error: unknown) {
        app.log.error({ err: error }, '[blueprints] failed periodic performance score recomputation');
      }
    })();
  }, 6 * 60 * 60 * 1000); // every 6 hours

  app.addHook('onClose', async () => {
    clearInterval(performanceRefreshTimer);
  });

  // GET /blueprints/presets — list available strategy presets for a style
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/blueprints/presets', async (req, reply) => {
    const parsed = StyleQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    const presets = listPresets(parsed.data.style);
    return reply.send({ presets });
  });

  // GET /blueprints/defaults — default strategy/risk/execution from the standard momentum preset
  app.get('/blueprints/defaults', async (_request, reply) => {
    const defaultPreset = getPreset('momentum', 'standard');
    if (!defaultPreset) {
      return reply.status(500).send({ error: 'internal_error', message: 'Default preset not found' });
    }
    const defaults = {
      strategy: defaultPreset.strategy,
      risk: defaultPreset.risk ?? {},
      execution: defaultPreset.execution ?? { mode: 'paper' },
    };
    return reply.send({ defaults });
  });

  // TODO (Phase 1 Milestone B): POST /blueprints/from-preset — create a blueprint pre-populated from a YAML preset.
  // Stubbed — old schema columns (userId, configData, configVersion, visibility) no longer exist.
  app.post<{ Body: unknown }>('/blueprints/from-preset', async (_request, reply) => {
    return reply.status(501).send({
      error: 'not_implemented',
      message: 'This endpoint will be reimplemented in Milestone B using the new blueprint schema (authorId, revisions, publicationStatus).',
    });
  });

  // GET /presets/for-agent — return preset split into agent-consumable sections
  // Registered before /:id so Fastify doesn't swallow it as a param.
  app.get('/presets/for-agent', async (req, reply) => {
    const parsed = ForAgentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }
    // Reject DCA at the API boundary — DCA is bot-only.
    if (parsed.data.strategy === 'dca') {
      return reply.status(400).send({
        error: 'preset_not_supported_for_agent',
        message: 'DCA is a bot-only strategy and cannot be applied to agents.',
      });
    }

    const preset = getPreset(parsed.data.strategy, parsed.data.style);
    if (!preset) {
      return reply.status(404).send({
        error: 'preset_not_found',
        message: `Preset "${parsed.data.strategy}" not found for style "${parsed.data.style}"`,
      });
    }
    const split = applyPresetToAgent(parsed.data.strategy, preset, parsed.data.style, parsed.data.mode);
    return reply.send(split);
  });

  // GET /blueprints — browse published blueprints with cursor pagination.
  // This is a pure marketplace surface: it returns ALL published blueprints
  // (not owner-scoped), so every non-admin user must pass the entitlement gate.
  app.get<{ Querystring: unknown }>('/blueprints', async (request, reply) => {
    // Marketplace entitlement check for non-admin users
    if (!request.isAdmin) {
      const entitlements = resolvePlanBlueprintEntitlements(plansConfig, request.userPlanId);
      if (!entitlements.canViewMarketplaceBlueprints) {
        return reply.status(403).send({
          error: BlueprintErrorCodes.FORBIDDEN,
          message: 'Your plan does not include marketplace access',
        });
      }
    }

    const rawQuery = request.query as Record<string, unknown>;

    // Parse tags from comma-separated string if provided
    if (typeof rawQuery.tags === 'string' && rawQuery.tags.length > 0) {
      rawQuery.tags = rawQuery.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    }

    const parsed = BlueprintBrowseQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const query = parsed.data;
    const limit = query.limit;

    // Build WHERE clauses
    const whereClauses: SQL[] = [
      eq(blueprints.publicationStatus, 'published'),
      sql`${blueprints.publishedRevisionId} IS NOT NULL`,
    ];

    if (query.kind) {
      whereClauses.push(eq(blueprints.kind, query.kind));
    }
    if (query.strategyType) {
      whereClauses.push(eq(blueprints.strategyType, query.strategyType));
    }
    if (query.style) {
      whereClauses.push(eq(blueprints.style, query.style));
    }
    if (query.venueType) {
      whereClauses.push(eq(blueprints.venueType, query.venueType));
    }
    if (query.tags && query.tags.length > 0) {
      // ANY match: blueprint has at least one of the requested tags
      const tagConditions = query.tags.map((tag) => sql`${tag} = ANY(${blueprints.tags})`);
      whereClauses.push(or(...tagConditions)!);
    }

    // Decode cursor for pagination
    const cursorValues = query.cursor ? decodeBlueprintCursor(query.cursor) : {};
    const lastScore = cursorValues.score !== undefined ? Number(cursorValues.score) : undefined;
    const lastId = cursorValues.id as string | undefined;
    const lastPublishedAt = cursorValues.publishedAt as string | undefined;

    // Build cursor WHERE clause for pagination
    if (lastId) {
      if (query.sort === 'trending') {
        // trendingScore DESC, popularityScore DESC, id ASC
        if (lastScore !== undefined && cursorValues.popularityScore !== undefined) {
          const lastPop = Number(cursorValues.popularityScore);
          whereClauses.push(
            or(
              sql`${blueprints.trendingScore} < ${lastScore}`,
              and(
                sql`${blueprints.trendingScore} = ${lastScore}`,
                sql`${blueprints.popularityScore} < ${lastPop}`,
              )!,
              and(
                sql`${blueprints.trendingScore} = ${lastScore}`,
                sql`${blueprints.popularityScore} = ${lastPop}`,
                sql`${blueprints.id} > ${lastId}`,
              )!,
            )!,
          );
        }
      } else if (query.sort === 'newest') {
        // publishedAt DESC, id ASC
        if (lastPublishedAt) {
          whereClauses.push(
            or(
              sql`${blueprints.publishedAt} < ${new Date(lastPublishedAt).toISOString()}`,
              and(
                sql`${blueprints.publishedAt} = ${new Date(lastPublishedAt).toISOString()}`,
                sql`${blueprints.id} > ${lastId}`,
              )!,
            )!,
          );
        }
      } else if (query.sort === 'ranking') {
        // performanceScore DESC, id ASC
        if (lastScore !== undefined) {
          whereClauses.push(
            or(
              sql`${blueprints.performanceScore} < ${lastScore}`,
              and(
                sql`${blueprints.performanceScore} = ${lastScore}`,
                sql`${blueprints.id} > ${lastId}`,
              )!,
            )!,
          );
        }
      } else {
        // 'popular' (default): popularityScore DESC, id ASC
        if (lastScore !== undefined) {
          whereClauses.push(
            or(
              sql`${blueprints.popularityScore} < ${lastScore}`,
              and(
                sql`${blueprints.popularityScore} = ${lastScore}`,
                sql`${blueprints.id} > ${lastId}`,
              )!,
            )!,
          );
        }
      }
    }

    // Build query with dynamic WHERE
    let rowsQuery = db.select().from(blueprints).$dynamic();
    if (whereClauses.length === 1) {
      rowsQuery = rowsQuery.where(whereClauses[0]!);
    } else if (whereClauses.length > 1) {
      rowsQuery = rowsQuery.where(and(...whereClauses)!);
    }

    // ORDER BY
    if (query.sort === 'trending') {
      rowsQuery = rowsQuery.orderBy(desc(blueprints.trendingScore), desc(blueprints.popularityScore), asc(blueprints.id));
    } else if (query.sort === 'newest') {
      rowsQuery = rowsQuery.orderBy(desc(blueprints.publishedAt), asc(blueprints.id));
    } else if (query.sort === 'ranking') {
      rowsQuery = rowsQuery.orderBy(desc(blueprints.performanceScore), asc(blueprints.id));
    } else {
      // 'popular' (default)
      rowsQuery = rowsQuery.orderBy(desc(blueprints.popularityScore), asc(blueprints.id));
    }

    // Fetch one extra to determine if there's a next page
    rowsQuery = rowsQuery.limit(limit + 1);
    const rows = await rowsQuery;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    // Build summaries from publishedRevisionId
    const revisionIds = pageRows
      .map((r) => r.publishedRevisionId)
      .filter((id): id is string => id !== null);
    const revisionRows = revisionIds.length > 0
      ? await db.select().from(blueprintRevisions).where(inArray(blueprintRevisions.id, revisionIds))
      : [];
    const revisionById = new Map(revisionRows.map((r) => [r.id, r]));

    // Batch-load viewer likes for the current page
    const pageIds = pageRows.map((r) => r.id);
    let likedIds = new Set<string>();
    if (pageIds.length > 0) {
      const likeRows = await db
        .select({ blueprintId: blueprintLikes.blueprintId })
        .from(blueprintLikes)
        .where(and(
          eq(blueprintLikes.userId, request.userId),
          inArray(blueprintLikes.blueprintId, pageIds),
        ));
      likedIds = new Set(likeRows.map((r) => r.blueprintId));
    }

    const items = pageRows.map((bp) => {
      const rev = bp.publishedRevisionId ? revisionById.get(bp.publishedRevisionId) : null;
      return BlueprintSummarySchema.parse({
        id: bp.id,
        authorId: bp.authorId,
        publicationStatus: bp.publicationStatus,
        kind: bp.kind,
        name: rev?.name ?? bp.name,
        description: rev?.description ?? bp.description,
        tags: rev?.tags ?? bp.tags,
        strategyType: rev?.strategyType ?? bp.strategyType,
        style: rev?.style ?? bp.style,
        venueType: rev?.venueType ?? bp.venueType,
        likeCount: bp.likeCount,
        forkCount: bp.forkCount,
        isLikedByViewer: likedIds.has(bp.id),
        popularityScore: bp.popularityScore,
        trendingScore: bp.trendingScore,
        performanceScore: bp.performanceScore,
        publishedAt: bp.publishedAt?.toISOString() ?? null,
        currentRevisionId: bp.currentRevisionId!,
        publishedRevisionId: bp.publishedRevisionId,
        sourceBlueprintId: bp.sourceBlueprintId,
        createdAt: bp.createdAt.toISOString(),
        updatedAt: bp.updatedAt.toISOString(),
      });
    });

    // Build next cursor
    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      const cursorPayload: Record<string, unknown> = { id: last.id };
      if (query.sort === 'newest') {
        cursorPayload.publishedAt = last.publishedAt?.toISOString() ?? '';
        cursorPayload.score = 0;
      } else if (query.sort === 'trending') {
        cursorPayload.score = last.trendingScore;
        cursorPayload.popularityScore = last.popularityScore;
      } else if (query.sort === 'ranking') {
        cursorPayload.score = last.performanceScore;
      } else {
        cursorPayload.score = last.popularityScore;
      }
      nextCursor = encodeBlueprintCursor(cursorPayload);
    }

    return reply.send({ items, nextCursor });
  });

  // POST /blueprints — create a new blueprint from scratch
  app.post<{ Body: unknown }>('/blueprints', async (request, reply) => {
    const parsed = CreateBlueprintSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const payload = parsed.data.payload;
    const skills = parsed.data.skills ?? [];

    // Validate skill portability for agent blueprints
    if (payload.kind === 'agent' && skills.length > 0) {
      const portability = await validateSkillPortability(skills, db);
      if (!portability.valid) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE,
          message: portability.errors.join('; '),
        });
      }
    }

    const blueprintId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date();

    // Derive facets from payload
    const bpName = payload.name;
    const bpDescription = payload.description;
    const bpTags = payload.tags;
    const bpStrategyType = payload.kind === 'agent'
      ? (payload.strategy?.type as string | undefined) ?? null
      : (payload.strategy?.type as string | undefined) ?? null;
    const bpStyle = payload.kind === 'agent' ? payload.style : null;
    const bpVenueType = payload.kind === 'bot' ? payload.venueType : null;

    await db.transaction(async (tx) => {
      // Step 1: Insert blueprint with currentRevisionId = null to satisfy
      // the non-deferrable composite FK fk_blueprints_current_revision.
      await tx.insert(blueprints).values({
        id: blueprintId,
        authorId: request.userId,
        publicationStatus: 'draft',
        kind: payload.kind,
        name: bpName,
        description: bpDescription,
        strategyType: bpStrategyType,
        style: bpStyle,
        tags: bpTags,
        venueType: bpVenueType,
        currentRevisionId: null,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(blueprintRevisions).values({
        id: revisionId,
        blueprintId,
        version: 1,
        kind: payload.kind,
        name: bpName,
        description: bpDescription,
        strategyType: bpStrategyType,
        style: bpStyle,
        tags: bpTags,
        venueType: bpVenueType,
        payload,
        createdByUserId: request.userId,
        createdAt: now,
      });

      // Step 3: Set currentRevisionId now that the revision exists.
      await tx.update(blueprints).set({
        currentRevisionId: revisionId,
        updatedAt: now,
      }).where(eq(blueprints.id, blueprintId));

      if (skills.length > 0) {
        await tx.insert(blueprintRevisionSkills).values(
          skills.map((s, i) => ({
            blueprintRevisionId: revisionId,
            skillId: s.skillId,
            skillRevisionId: s.skillRevisionId,
            orderIndex: i,
          })),
        );
      }
    });

    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, blueprintId)).limit(1);
    const [rev] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, revisionId)).limit(1);
    if (!bp || !rev) {
      return reply.status(500).send({ error: 'internal_error', message: 'Failed to create blueprint' });
    }
    const detail = await buildBlueprintDetail(db, bp, rev);
    return reply.status(201).send(detail);
  });

  // GET /blueprints/:id — retrieve a single blueprint detail
  app.get<{ Params: { id: string }; Querystring: { revisionId?: string } }>('/blueprints/:id', async (request, reply) => {
    const resolved = await resolveTargetRevision(
      db,
      request.params.id,
      request.query?.revisionId,
      request.userId,
      request.isAdmin,
    );
    if ('error' in resolved) {
      const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
        : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
        : 400;
      return reply.status(status).send({ error: resolved.code, message: resolved.error });
    }

    const { blueprint: bp, revision } = resolved;

    // Marketplace entitlement check for non-owner, non-admin accessing published blueprints.
    // The bp.publicationStatus === 'published' guard is redundant here because
    // resolveTargetRevision already rejects non-published blueprints for non-owner/non-admin
    // callers. It's kept as a belt-and-suspenders check for clarity.
    if (!request.isAdmin && bp.authorId !== request.userId && bp.publicationStatus === 'published') {
      const entitlements = resolvePlanBlueprintEntitlements(plansConfig, request.userPlanId);
      if (!entitlements.canViewMarketplaceBlueprints) {
        return reply.status(403).send({
          error: BlueprintErrorCodes.FORBIDDEN,
          message: 'Your plan does not include marketplace access',
        });
      }
    }

    // Check viewer like state (after entitlement gate — avoids wasted query for rejected users)
    const [likeRow] = await db
      .select()
      .from(blueprintLikes)
      .where(and(
        eq(blueprintLikes.blueprintId, bp.id),
        eq(blueprintLikes.userId, request.userId),
      ))
      .limit(1);
    const isLikedByViewer = likeRow !== undefined;

    const detail = await buildBlueprintDetail(db, bp, revision, undefined, isLikedByViewer);
    return reply.send(detail);
  });

  // POST /blueprints/:id/revisions — create a new revision (edit the blueprint)
  app.post<{ Params: { id: string }; Body: unknown }>('/blueprints/:id/revisions', async (request, reply) => {
    const parsed = CreateBlueprintRevisionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [bp] = await db.select().from(blueprints)
      .where(and(eq(blueprints.id, request.params.id)))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can edit
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    // Stale edit detection: if expectedBaseRevisionId is provided, verify it matches currentRevisionId
    if (parsed.data.expectedBaseRevisionId && parsed.data.expectedBaseRevisionId !== bp.currentRevisionId) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.REVISION_STALE,
        message: 'Current revision has changed since the expected base was captured. Re-fetch and retry.',
      });
    }

    const payload = parsed.data.payload;
    const changeSummary = parsed.data.changeSummary ?? null;

    // Validate skill portability for agent blueprints (if skills are referenced in the payload)
    if (payload.kind === 'agent') {
      // For edits, we don't have skills in the body — they stay with the current revision's skills.
      // Agent payload changes don't affect skill dependencies in Phase 1.
      // Skills are managed at creation time only (POST /blueprints, POST /agents/:id/blueprints).
    }

    const newRevisionId = crypto.randomUUID();
    const now = new Date();

    // Derive facets from the new payload
    const revName = payload.name;
    const revDescription = payload.description;
    const revTags = payload.tags;
    const revStrategyType = payload.kind === 'agent'
      ? (payload.strategy?.type as string | undefined) ?? null
      : (payload.strategy?.type as string | undefined) ?? null;
    const revStyle = payload.kind === 'agent' ? payload.style : null;
    const revVenueType = payload.kind === 'bot' ? payload.venueType : null;

    await db.transaction(async (tx) => {
      // Lock blueprint FOR UPDATE
      const [lockedBp] = await tx
        .select()
        .from(blueprints)
        .where(eq(blueprints.id, bp.id))
        .for('update');
      if (!lockedBp) {
        throw new Error('Blueprint not found under lock');
      }

      // Allocate version
      const [maxRow] = await tx.execute(sql`
        SELECT COALESCE(MAX(version), 0)::int AS max_ver
        FROM blueprint_revisions
        WHERE blueprint_id = ${bp.id}
      `);
      const nextVersion = (Number((maxRow as { max_ver: number } | undefined)?.max_ver ?? 0)) + 1;

      // Insert new revision
      await tx.insert(blueprintRevisions).values({
        id: newRevisionId,
        blueprintId: bp.id,
        version: nextVersion,
        kind: payload.kind,
        name: revName,
        description: revDescription,
        strategyType: revStrategyType,
        style: revStyle,
        tags: revTags,
        venueType: revVenueType,
        payload,
        changeSummary,
        createdByUserId: request.userId,
        createdAt: now,
      });

      // Copy skill dependencies from the *previous* current revision (skills are immutable per creation)
      // If this is an agent blueprint, the skills stay the same across revisions
      if (bp.currentRevisionId && bp.kind === 'agent') {
        const prevSkillRefs = await getRevisionSkillRefs(tx as unknown as Database, bp.currentRevisionId);
        if (prevSkillRefs.length > 0) {
          await tx.insert(blueprintRevisionSkills).values(
            prevSkillRefs.map((s, i) => ({
              blueprintRevisionId: newRevisionId,
              skillId: s.skillId,
              skillRevisionId: s.skillRevisionId,
              orderIndex: i,
            })),
          );
        }
      }

      // Advance currentRevisionId and update facets
      // Do NOT change publishedRevisionId or publicationStatus
      await tx.update(blueprints).set({
        currentRevisionId: newRevisionId,
        name: revName,
        description: revDescription,
        tags: revTags,
        strategyType: revStrategyType,
        style: revStyle,
        venueType: revVenueType,
        updatedAt: now,
      }).where(eq(blueprints.id, bp.id));
    });

    const [updatedBp] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    const [newRev] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, newRevisionId)).limit(1);
    if (!updatedBp || !newRev) {
      return reply.status(500).send({ error: 'internal_error', message: 'Failed to create revision' });
    }
    const detail = await buildBlueprintDetail(db, updatedBp, newRev);
    return reply.status(201).send(detail);
  });

  // DELETE /blueprints/:id — hard delete (only for eligible draft blueprints)
  app.delete<{ Params: { id: string } }>('/blueprints/:id', async (request, reply) => {
    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can delete
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    // Only draft blueprints that have never been published are eligible
    if (bp.publicationStatus !== 'draft') {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: 'Only draft blueprints can be hard-deleted',
      });
    }

    if (bp.publishedRevisionId !== null || bp.publishedAt !== null) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: 'Cannot delete a blueprint that has been published',
      });
    }

    const deleteResult = await db.transaction(async (tx) => {
      // Lock the blueprint row
      const [lockedBp] = await tx.select().from(blueprints)
        .where(eq(blueprints.id, bp.id))
        .for('update');
      if (!lockedBp) return { kind: 'error' as const, code: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' };

      // Verify predicates under lock
      if (lockedBp.publicationStatus !== 'draft' || lockedBp.publishedRevisionId !== null || lockedBp.publishedAt !== null) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint is not eligible for hard delete' };
      }

      // Check for references: likes
      const [likeCheck] = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM blueprint_likes WHERE blueprint_id = ${bp.id}
      `);
      if (Number(likeCheck?.cnt ?? 0) > 0) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has likes' };
      }

      // Check for references: usage events
      const [usageCheck] = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM blueprint_usage_events WHERE blueprint_id = ${bp.id}
      `);
      if (Number(usageCheck?.cnt ?? 0) > 0) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has usage events' };
      }

      // Check for references: fork requests where this is the source
      const [forkCheck] = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM blueprint_fork_requests WHERE source_blueprint_id = ${bp.id}
      `);
      if (Number(forkCheck?.cnt ?? 0) > 0) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has fork references' };
      }

      // Check for agents referencing this blueprint
      const [agentCheck] = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM agents WHERE blueprint_id = ${bp.id}
      `);
      if (Number(agentCheck?.cnt ?? 0) > 0) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has active agent instances' };
      }

      // Check for bots referencing this blueprint
      const [botCheck] = await tx.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM bots WHERE blueprint_id = ${bp.id}
      `);
      if (Number(botCheck?.cnt ?? 0) > 0) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has active bot instances' };
      }

      // Break pointer cycle
      await tx.update(blueprints).set({
        currentRevisionId: null,
        publishedRevisionId: null,
      }).where(eq(blueprints.id, bp.id));

      // Delete revision skills
      const revisions = await tx.select({ id: blueprintRevisions.id })
        .from(blueprintRevisions)
        .where(eq(blueprintRevisions.blueprintId, bp.id));
      const revisionIds = revisions.map((r) => r.id);
      if (revisionIds.length > 0) {
        await tx.delete(blueprintRevisionSkills)
          .where(inArray(blueprintRevisionSkills.blueprintRevisionId, revisionIds));
      }

      // Delete revisions
      await tx.delete(blueprintRevisions)
        .where(eq(blueprintRevisions.blueprintId, bp.id));

      // Delete the blueprint
      await tx.delete(blueprints).where(eq(blueprints.id, bp.id));

      return { kind: 'deleted' as const };
    });

    if (deleteResult.kind === 'error') {
      const status = deleteResult.code === BlueprintErrorCodes.NOT_FOUND ? 404 : 409;
      return reply.status(status).send({ error: deleteResult.code, message: deleteResult.message });
    }

    return reply.status(204).send();
  });

  // POST /blueprints/:id/fork — fork a blueprint (idempotent)
  app.post<{ Params: { id: string }; Body: unknown }>('/blueprints/:id/fork', async (request, reply) => {
    // Validate Idempotency-Key header
    const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? '';
    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length < 1 || trimmedKey.length > 200) {
      return reply.status(400).send({
        error: BlueprintErrorCodes.VALIDATION,
        message: 'Idempotency-Key header must be 1-200 printable ASCII characters',
      });
    }
    if (!/^[\x20-\x7E]+$/.test(trimmedKey)) {
      return reply.status(400).send({
        error: BlueprintErrorCodes.VALIDATION,
        message: 'Idempotency-Key must contain only printable ASCII characters',
      });
    }

    const parsed = BlueprintForkRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Resolve the source blueprint + revision
    const resolved = await resolveTargetRevision(
      db,
      request.params.id,
      parsed.data.revisionId,
      request.userId,
      request.isAdmin,
    );
    if ('error' in resolved) {
      const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
        : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
        : 400;
      return reply.status(status).send({ error: resolved.code, message: resolved.error });
    }

    const { blueprint: sourceBp, revision: sourceRevision } = resolved;

    // Marketplace entitlement check for non-owner, non-admin
    if (!request.isAdmin && sourceBp.authorId !== request.userId) {
      const entitlements = resolvePlanBlueprintEntitlements(plansConfig, request.userPlanId);
      if (!entitlements.canViewMarketplaceBlueprints) {
        return reply.status(403).send({
          error: BlueprintErrorCodes.FORBIDDEN,
          message: 'Your plan does not include marketplace access',
        });
      }
    }

    // Compute fork request hash
    const forkHash = computeForkRequestHash({
      sourceBlueprintId: sourceBp.id,
      sourceBlueprintRevisionId: sourceRevision.id,
      edits: parsed.data.edits ?? null,
    });

    const lockKey = `fork:${request.userId}:${trimmedKey}`;
    const forkBpId = crypto.randomUUID();
    const forkRevisionId = crypto.randomUUID();
    const forkReqId = crypto.randomUUID();
    const usageEventId = crypto.randomUUID();
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // Advisory lock serializes per (userId, idempotencyKey)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      // Check for existing completed fork request
      const [existing] = await tx
        .select()
        .from(blueprintForkRequests)
        .where(
          and(
            eq(blueprintForkRequests.userId, request.userId),
            eq(blueprintForkRequests.idempotencyKey, trimmedKey),
          ),
        );

      if (existing) {
        if (existing.requestHash === forkHash) {
          // Same hash → return stored fork
          return {
            kind: 'idempotent_replay' as const,
            forkBlueprintId: existing.forkBlueprintId,
            responsePayload: existing.responsePayload,
          };
        }
        return { kind: 'idempotency_conflict' as const };
      }

      // Lock source blueprint
      const [lockedSource] = await tx
        .select()
        .from(blueprints)
        .where(eq(blueprints.id, sourceBp.id))
        .for('update');
      if (!lockedSource) {
        return { kind: 'error' as const, code: BlueprintErrorCodes.NOT_FOUND, message: 'Source blueprint not found' };
      }

      // Copy revision payload
      const sourcePayload = sourceRevision.payload;
      let forkPayload: Record<string, unknown>;
      if (parsed.data.edits) {
        forkPayload = deepMergeEdits(sourcePayload, parsed.data.edits);
      } else {
        forkPayload = { ...sourcePayload };
      }

      // Ensure kind is preserved
      forkPayload.kind = sourceRevision.kind;

      // Derive facets from payload
      const forkName = `${sourceRevision.name} (fork)`;
      const forkDescription = sourceRevision.description;
      const forkStrategyType = (forkPayload.strategyType as string) ?? sourceRevision.strategyType;
      const forkStyle = (forkPayload.style as string) ?? sourceRevision.style;
      const forkTags = (forkPayload.tags as string[]) ?? sourceRevision.tags;
      const forkVenueType = (forkPayload.venueType as string) ?? sourceRevision.venueType;

      // Create new blueprint (draft, with lineage)
      // Step 1: Insert blueprint with currentRevisionId = null to satisfy
      // the non-deferrable composite FK fk_blueprints_current_revision.
      await tx.insert(blueprints).values({
        id: forkBpId,
        authorId: request.userId,
        publicationStatus: 'draft',
        kind: sourceRevision.kind,
        name: forkName,
        description: forkDescription,
        strategyType: forkStrategyType,
        style: forkStyle,
        tags: forkTags,
        venueType: forkVenueType,
        sourceBlueprintId: sourceBp.id,
        sourceBlueprintRevisionId: sourceRevision.id,
        currentRevisionId: null,
        createdAt: now,
        updatedAt: now,
      });

      // Create revision 1
      await tx.insert(blueprintRevisions).values({
        id: forkRevisionId,
        blueprintId: forkBpId,
        version: 1,
        kind: sourceRevision.kind,
        name: forkName,
        description: forkDescription,
        strategyType: forkStrategyType,
        style: forkStyle,
        tags: forkTags,
        venueType: forkVenueType,
        payload: forkPayload,
        changeSummary: `Forked from ${sourceBp.id}`,
        createdByUserId: request.userId,
        createdAt: now,
      });

      // Copy skill dependencies for agent blueprints
      if (sourceRevision.kind === 'agent') {
        const skillRefs = await getRevisionSkillRefs(tx as unknown as Database, sourceRevision.id);
        if (skillRefs.length > 0) {
          await tx.insert(blueprintRevisionSkills).values(
            skillRefs.map((s, i) => ({
              blueprintRevisionId: forkRevisionId,
              skillId: s.skillId,
              skillRevisionId: s.skillRevisionId,
              orderIndex: i,
            })),
          );
        }
      }

      // Step 3: Set currentRevisionId now that the revision exists.
      await tx.update(blueprints).set({
        currentRevisionId: forkRevisionId,
        updatedAt: now,
      }).where(eq(blueprints.id, forkBpId));

      // Emit fork_created usage event (credits the source blueprint)
      await tx.insert(blueprintUsageEvents).values({
        id: usageEventId,
        blueprintId: sourceBp.id,
        blueprintRevisionId: sourceRevision.id,
        userId: request.userId,
        subjectKind: 'blueprint',
        subjectId: forkBpId,
        eventType: 'fork_created',
        isSelfUsage: sourceBp.authorId === request.userId,
        occurredAt: now,
        metadata: {
          idempotencyKey: trimmedKey,
          forkBlueprintId: forkBpId,
        },
      });

      // Record idempotency result
      const responsePayload: Record<string, unknown> = {
        forkBlueprintId: forkBpId,
        sourceBlueprintId: sourceBp.id,
        sourceBlueprintRevisionId: sourceRevision.id,
        createdAt: now.toISOString(),
      };
      await tx.insert(blueprintForkRequests).values({
        id: forkReqId,
        userId: request.userId,
        idempotencyKey: trimmedKey,
        requestHash: forkHash,
        sourceBlueprintId: sourceBp.id,
        sourceBlueprintRevisionId: sourceRevision.id,
        forkBlueprintId: forkBpId,
        responsePayload,
      });

      return {
        kind: 'created' as const,
        forkBlueprintId: forkBpId,
        responsePayload,
      };
    });

    // Handle transaction result
    if (result.kind === 'idempotent_replay') {
      return reply.status(200).send(result.responsePayload);
    }
    if (result.kind === 'idempotency_conflict') {
      return reply.status(409).send({
        error: BlueprintErrorCodes.IDEMPOTENCY_CONFLICT,
        message: 'Different request body for the same idempotency key',
      });
    }
    if (result.kind === 'error') {
      const status = result.code === BlueprintErrorCodes.NOT_FOUND ? 404 : 400;
      return reply.status(status).send({ error: result.code, message: result.message });
    }

    // Refresh fork count and recompute scores for source after transaction commit
    await refreshForkCount(db, sourceBp.id);
    await recomputeBlueprintScores(db, sourceBp.id);

    // Return the new fork detail
    const [forkBp] = await db.select().from(blueprints).where(eq(blueprints.id, forkBpId)).limit(1);
    const [forkRev] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, forkRevisionId)).limit(1);
    if (forkBp && forkRev) {
      const detail = await buildBlueprintDetail(db, forkBp, forkRev, {
        sourceBlueprintId: sourceBp.id,
        sourceBlueprintRevisionId: sourceRevision.id,
      });
      return reply.status(201).send(detail);
    }

    return reply.status(201).send(result.responsePayload);
  });

  // POST /blueprints/:id/publish — publish the current revision to marketplace
  app.post<{ Params: { id: string }; Body: unknown }>('/blueprints/:id/publish', async (request, reply) => {
    const parsed = PublishBlueprintSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can publish
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    // Check allowed transition
    if (!isAllowedTransition(bp.publicationStatus, 'published')) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: `Cannot publish from status "${bp.publicationStatus}"`,
      });
    }

    // Verify expectedCurrentRevisionId matches
    if (parsed.data.expectedCurrentRevisionId !== bp.currentRevisionId) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.REVISION_STALE,
        message: 'Current revision has changed since the expected value was captured',
      });
    }

    const targetRevisionId = bp.currentRevisionId;
    if (!targetRevisionId) {
      return reply.status(409).send({ error: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Blueprint has no current revision' });
    }

    // Load the revision
    const [revision] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, targetRevisionId));
    if (!revision) {
      return reply.status(409).send({ error: BlueprintErrorCodes.LIFECYCLE_CONFLICT, message: 'Current revision not found' });
    }

    // Validate skill portability for agent blueprints
    if (bp.kind === 'agent') {
      const skillRefs = await getRevisionSkillRefs(db, targetRevisionId);
      if (skillRefs.length > 0) {
        const portability = await validateSkillPortability(skillRefs, db);
        if (!portability.valid) {
          return reply.status(400).send({
            error: BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE,
            message: portability.errors.join('; '),
          });
        }
      }
    }

    const publishTime = new Date();

    await db.transaction(async (tx) => {
      await tx.update(blueprints).set({
        publicationStatus: 'published',
        publishedAt: publishTime,
        publishedRevisionId: targetRevisionId,
        delistedAt: null,
        // Copy current-revision facets
        name: revision.name,
        description: revision.description,
        tags: revision.tags,
        strategyType: revision.strategyType,
        style: revision.style,
        venueType: revision.venueType,
        updatedAt: publishTime,
      }).where(eq(blueprints.id, bp.id));
    });

    const [publishedBp] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    const detail = await buildBlueprintDetail(db, publishedBp!, revision);
    return reply.send(detail);
  });

  // POST /blueprints/:id/draft — move to draft status (from private)
  app.post<{ Params: { id: string } }>('/blueprints/:id/draft', async (request, reply) => {
    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can change lifecycle
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    if (!isAllowedTransition(bp.publicationStatus, 'draft')) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: `Cannot move to draft from status "${bp.publicationStatus}"`,
      });
    }

    await db.update(blueprints).set({
      publicationStatus: 'draft',
      updatedAt: new Date(),
    }).where(eq(blueprints.id, bp.id));

    const [updated] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    return reply.send({
      id: updated!.id,
      publicationStatus: updated!.publicationStatus,
      updatedAt: updated!.updatedAt.toISOString(),
    });
  });

  // POST /blueprints/:id/private — move to private status (from draft)
  app.post<{ Params: { id: string } }>('/blueprints/:id/private', async (request, reply) => {
    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can change lifecycle
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    if (!isAllowedTransition(bp.publicationStatus, 'private')) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: `Cannot move to private from status "${bp.publicationStatus}"`,
      });
    }

    await db.update(blueprints).set({
      publicationStatus: 'private',
      updatedAt: new Date(),
    }).where(eq(blueprints.id, bp.id));

    const [updated] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    return reply.send({
      id: updated!.id,
      publicationStatus: updated!.publicationStatus,
      updatedAt: updated!.updatedAt.toISOString(),
    });
  });

  // POST /blueprints/:id/delist — delist from marketplace (from published)
  app.post<{ Params: { id: string } }>('/blueprints/:id/delist', async (request, reply) => {
    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can change lifecycle
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    if (!isAllowedTransition(bp.publicationStatus, 'delisted')) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: `Cannot delist from status "${bp.publicationStatus}"`,
      });
    }

    const now = new Date();
    await db.update(blueprints).set({
      publicationStatus: 'delisted',
      delistedAt: now,
      updatedAt: now,
    }).where(eq(blueprints.id, bp.id));

    const [updated] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    return reply.send({
      id: updated!.id,
      publicationStatus: updated!.publicationStatus,
      delistedAt: updated!.delistedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    });
  });

  // POST /blueprints/:id/archive — archive the blueprint (terminal state)
  app.post<{ Params: { id: string } }>('/blueprints/:id/archive', async (request, reply) => {
    const [bp] = await db.select().from(blueprints)
      .where(eq(blueprints.id, request.params.id))
      .limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Only owner or admin can change lifecycle
    if (bp.authorId !== request.userId && !request.isAdmin) {
      return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
    }

    if (!isAllowedTransition(bp.publicationStatus, 'archived')) {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: `Cannot archive from status "${bp.publicationStatus}"`,
      });
    }

    const now = new Date();

    // Archive: keep published pointers if formerly published, set both delistedAt + archivedAt if published
    const updateData: Record<string, unknown> = {
      publicationStatus: 'archived',
      archivedAt: now,
      updatedAt: now,
    };
    if (bp.publicationStatus === 'published') {
      updateData['delistedAt'] = now;
    }

    await db.update(blueprints).set(updateData).where(eq(blueprints.id, bp.id));

    const [updated] = await db.select().from(blueprints).where(eq(blueprints.id, bp.id)).limit(1);
    return reply.send({
      id: updated!.id,
      publicationStatus: updated!.publicationStatus,
      archivedAt: updated!.archivedAt?.toISOString() ?? null,
      delistedAt: updated!.delistedAt?.toISOString() ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Like / Unlike
  // ─────────────────────────────────────────────────────────────────────────

  // PUT /blueprints/:id/like — like a published blueprint
  app.put<{ Params: { id: string } }>('/blueprints/:id/like', async (request, reply) => {
    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, request.params.id)).limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Must be published
    if (bp.publicationStatus !== 'published') {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: 'Only published blueprints can be liked',
      });
    }

    // Author cannot like own blueprint
    if (bp.authorId === request.userId) {
      return reply.status(403).send({
        error: BlueprintErrorCodes.FORBIDDEN,
        message: 'Authors cannot like their own blueprints',
      });
    }

    // Marketplace entitlement check for non-owner, non-admin
    if (!request.isAdmin && bp.authorId !== request.userId) {
      const entitlements = resolvePlanBlueprintEntitlements(plansConfig, request.userPlanId);
      if (!entitlements.canViewMarketplaceBlueprints || !entitlements.canLikeMarketplaceBlueprints) {
        return reply.status(403).send({
          error: BlueprintErrorCodes.FORBIDDEN,
          message: 'Your plan does not include marketplace like access',
        });
      }
    }

    await db.insert(blueprintLikes).values({
      blueprintId: bp.id,
      userId: request.userId,
      createdAt: new Date(),
    }).onConflictDoNothing();

    const likeCount = await refreshLikeCount(db, bp.id);
    await recomputeBlueprintScores(db, bp.id);
    return reply.send({ liked: true, likeCount });
  });

  // DELETE /blueprints/:id/like — unlike a published blueprint
  app.delete<{ Params: { id: string } }>('/blueprints/:id/like', async (request, reply) => {
    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, request.params.id)).limit(1);
    if (!bp) {
      return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
    }

    // Must be published (likes are only allowed on published blueprints)
    if (bp.publicationStatus !== 'published') {
      return reply.status(409).send({
        error: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
        message: 'Only published blueprints can be liked',
      });
    }

    // Marketplace entitlement check for non-owner, non-admin
    if (!request.isAdmin && bp.authorId !== request.userId) {
      const entitlements = resolvePlanBlueprintEntitlements(plansConfig, request.userPlanId);
      if (!entitlements.canViewMarketplaceBlueprints || !entitlements.canLikeMarketplaceBlueprints) {
        return reply.status(403).send({
          error: BlueprintErrorCodes.FORBIDDEN,
          message: 'Your plan does not include marketplace like access',
        });
      }
    }

    await db.delete(blueprintLikes).where(and(
      eq(blueprintLikes.blueprintId, bp.id),
      eq(blueprintLikes.userId, request.userId),
    ));

    const likeCount = await refreshLikeCount(db, bp.id);
    await recomputeBlueprintScores(db, bp.id);
    return reply.send({ liked: false, likeCount });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Revisions
  // ─────────────────────────────────────────────────────────────────────────

  // GET /blueprints/:id/revisions — list revisions (owner/admin only)
  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/blueprints/:id/revisions',
    async (request, reply) => {
      const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, request.params.id)).limit(1);
      if (!bp) {
        return reply.status(404).send({ error: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' });
      }

      // Owner/admin only
      if (bp.authorId !== request.userId && !request.isAdmin) {
        return reply.status(403).send({ error: BlueprintErrorCodes.FORBIDDEN });
      }

      const limit = Math.min(Math.max(parseInt(request.query?.limit ?? '20', 10) || 20, 1), 50);
      const cursor = request.query?.cursor;

      // Decode cursor for pagination (cursor contains last version + id)
      let cursorVersion: number | undefined;
      let cursorId: string | undefined;
      if (cursor) {
        const cv = decodeBlueprintCursor(cursor);
        cursorVersion = cv.version !== undefined ? Number(cv.version) : undefined;
        cursorId = cv.id as string | undefined;
      }

      const whereClauses: SQL[] = [eq(blueprintRevisions.blueprintId, bp.id)];
      if (cursorVersion !== undefined && cursorId) {
        whereClauses.push(
          or(
            sql`${blueprintRevisions.version} < ${cursorVersion}`,
            and(
              sql`${blueprintRevisions.version} = ${cursorVersion}`,
              sql`${blueprintRevisions.id} > ${cursorId}`,
            )!,
          )!,
        );
      }

      let revQuery = db.select().from(blueprintRevisions).$dynamic();
      if (whereClauses.length === 1) {
        revQuery = revQuery.where(whereClauses[0]!);
      } else {
        revQuery = revQuery.where(and(...whereClauses)!);
      }
      revQuery = revQuery.orderBy(desc(blueprintRevisions.version), asc(blueprintRevisions.id)).limit(limit + 1);

      const revisions = await revQuery;
      const hasMore = revisions.length > limit;
      const pageRevisions = hasMore ? revisions.slice(0, limit) : revisions;

      const items = pageRevisions.map((rev) =>
        BlueprintRevisionSummarySchema.parse({
          id: rev.id,
          blueprintId: rev.blueprintId,
          version: rev.version,
          kind: rev.kind,
          name: rev.name,
          description: rev.description,
          strategyType: rev.strategyType,
          style: rev.style,
          tags: rev.tags,
          venueType: rev.venueType,
          changeSummary: rev.changeSummary,
          createdByUserId: rev.createdByUserId,
          createdAt: rev.createdAt.toISOString(),
        }),
      );

      let nextCursor: string | null = null;
      if (hasMore && items.length > 0) {
        const last = pageRevisions[pageRevisions.length - 1]!;
        nextCursor = encodeBlueprintCursor({ version: last.version, id: last.id });
      }

      return reply.send({ items, nextCursor });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 Marketplace: Preview & Confirmation
  // ─────────────────────────────────────────────────────────────────────────

  // POST /blueprints/:blueprintId/instantiate/preview
  // Read-only preview — writes NOTHING to DB.
  app.post<{ Params: { blueprintId: string }; Body: unknown }>(
    '/blueprints/:blueprintId/instantiate/preview',
    async (request, reply) => {
      const parsed = BlueprintInstantiatePreviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          details: parsed.error.issues,
        });
      }

      const resolved = await resolveTargetRevision(
        db,
        request.params.blueprintId,
        parsed.data.revisionId,
        request.userId,
        request.isAdmin,
      );
      if ('error' in resolved) {
        const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : 400;
        return reply.status(status).send({ error: resolved.code, message: resolved.error });
      }

      const { blueprint: bp, revision } = resolved;
      const rawPayload = revision.payload;
      const isTrading = isTradingCapable(rawPayload);

      // Build the preview payload — deep-merge installer edits into the raw payload
      let editablePayload: Record<string, unknown>;
      if (parsed.data.edits) {
        editablePayload = deepMergeEdits(rawPayload, parsed.data.edits);
      } else {
        editablePayload = { ...rawPayload };
      }

      // Extract raw risk — rawPayload is Record<string, unknown> from DB, so .risk is unknown.
      // resolveEffectiveRisk expects RiskPosture | null and Partial<RiskPosture> | null.
      const rawRisk = (rawPayload.risk ?? null) as import('@herobids/domain').RiskPosture | null;

      // Resolve effective risk — parsed.data.edits is from the Zod-validated request.
      // Use the blueprint kind to narrow the discriminated union for risk access.
      const editsRisk = parsed.data.edits && parsed.data.edits.kind === 'agent'
        ? (parsed.data.edits as { risk?: Record<string, unknown> }).risk
        : undefined;
      const effectiveRisk = resolveEffectiveRisk(
        rawRisk,
        (editsRisk ?? null) as Partial<import('@herobids/domain').RiskPosture> | null,
        agentRiskDefaults,
      );

      // Resolve execution mode
      const agentPayload = rawPayload as AgentBlueprintRevisionPayload;
      const botPayload = rawPayload as BotBlueprintRevisionPayload;

      const rawExecDefaults = agentPayload.executionDefaults ?? botPayload.executionDefaults ?? null;
      const capabilityInput: BlueprintExecutionCapabilityInput = {
        kind: bp.kind as 'agent' | 'bot',
        tradingCapable: isTrading,
        executionDefaults: rawExecDefaults ? { mode: rawExecDefaults.mode, slippageBps: rawExecDefaults.slippageBps ?? 0 } : null,
        venue: botPayload.venue ?? (rawPayload.venue as string | null) ?? null,
        venueType: bp.venueType as 'orderbook' | 'swap' | null,
        swapAssets: botPayload.swapAssets ?? null,
        requestedMode: (parsed.data.requestedMode ?? null) as 'paper' | 'shadow' | 'live' | null,
        liveOptIn: parsed.data.liveOptIn ?? false,
        binding: parsed.data.bindings
          ? (parsed.data.bindings as { kind: 'agent'; connectionIds: string[] } | { kind: 'bot'; connectionId: string; venueAccountId: string })
          : null,
      };

      const capResult = await executionCapabilityResolver.resolve(capabilityInput);

      // Collect warnings
      const warnings: string[] = [...capResult.warnings];

      // Required private inputs
      const requiredPrivateInputs: string[] = [];
      if (isTrading && bp.kind === 'agent') {
        // Check if binding connections need validation
        if (capResult.resolvedMode === 'live' || capResult.resolvedMode === 'shadow') {
          const bindingIds = parsed.data.bindings &&
            'connectionIds' in parsed.data.bindings
            ? (parsed.data.bindings as { connectionIds: string[] }).connectionIds
            : [];
          if (bindingIds.length === 0) {
            requiredPrivateInputs.push('connectionIds: at least one active trading connection required for shadow/live');
          }
        }
      } else if (isTrading && bp.kind === 'bot') {
        if (!parsed.data.bindings || !('connectionId' in parsed.data.bindings)) {
          requiredPrivateInputs.push('connectionId: exactly one active connection required for bot');
          requiredPrivateInputs.push('venueAccountId: exactly one venue account required for bot');
        }
      }

      const compatibleExecutionModes: string[] = [];
      if (!isTrading) {
        // No execution modes for non-trading
      } else if (bp.venueType === 'swap') {
        compatibleExecutionModes.push('shadow', 'live');
      } else {
        compatibleExecutionModes.push('paper', 'shadow', 'live');
      }

      const response = {
        blueprintId: bp.id,
        revisionId: revision.id,
        kind: bp.kind,
        rawPayload: editablePayload,
        rawRisk,
        effectiveRisk,
        requiredPrivateInputs,
        compatibleExecutionModes,
        selectedResolvedMode: capResult.resolvedMode,
        validationWarnings: [...warnings, ...capResult.errors],
      };

      // Validate response shape
      const responseParsed = BlueprintInstantiatePreviewResponseSchema.safeParse(response);
      if (!responseParsed.success) {
        return reply.status(500).send({
          error: 'internal_error',
          message: 'Preview response validation failed',
          details: responseParsed.error.issues,
        });
      }

      return reply.send(responseParsed.data);
    },
  );

  // POST /blueprints/:blueprintId/instantiate
  // Idempotent confirmation — creates a STOPPED actor with attribution.
  app.post<{ Params: { blueprintId: string }; Body: unknown }>(
    '/blueprints/:blueprintId/instantiate',
    async (request, reply) => {
      // 1. Validate Idempotency-Key header
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? '';
      const trimmedKey = idempotencyKey.trim();
      if (trimmedKey.length < 1 || trimmedKey.length > 200) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          message: 'Idempotency-Key header must be 1-200 printable ASCII characters',
        });
      }
      // Validate printable ASCII only
      if (!/^[\x20-\x7E]+$/.test(trimmedKey)) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          message: 'Idempotency-Key must contain only printable ASCII characters',
        });
      }

      // 2. Parse request body
      const parsed = BlueprintInstantiateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: BlueprintErrorCodes.VALIDATION,
          details: parsed.error.issues,
        });
      }

      // 3. Resolve the blueprint + revision
      const resolved = await resolveTargetRevision(
        db,
        request.params.blueprintId,
        parsed.data.revisionId,
        request.userId,
        request.isAdmin,
      );
      if ('error' in resolved) {
        const status = resolved.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : resolved.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : 400;
        return reply.status(status).send({ error: resolved.code, message: resolved.error });
      }

      const { blueprint: bp, revision } = resolved;
      const rawPayload = revision.payload;
      const isTrading = isTradingCapable(rawPayload);

      // 4. Compute request hash
      const binding = parsed.data.bindings;
      const bindingIds = binding
        ? binding.kind === 'bot'
          ? [binding.connectionId, binding.venueAccountId].sort()
          : [...new Set(binding.connectionIds)].sort()
        : null;
      const requestHash = computeInstantiateRequestHash({
        operation: 'instantiate',
        blueprintId: bp.id,
        revisionId: revision.id,
        kind: bp.kind,
        edits: parsed.data.edits ?? null,
        bindingIds,
        requestedMode: parsed.data.requestedMode ?? null,
        liveOptIn: parsed.data.liveOptIn ?? null,
      });

      // 5. Take advisory lock and check idempotency
      const lockKey = `instantiate:${request.userId}:${trimmedKey}`;
      const actorId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      const instantiationReqId = crypto.randomUUID();
      const now = new Date();

      const result = await db.transaction(async (tx) => {
        // Advisory lock serializes per (userId, idempotencyKey)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
        );

        // Check for existing completed request
        const [existing] = await tx
          .select()
          .from(blueprintInstantiationRequests)
          .where(
            and(
              eq(blueprintInstantiationRequests.userId, request.userId),
              eq(blueprintInstantiationRequests.idempotencyKey, trimmedKey),
            ),
          );

        if (existing) {
          if (existing.requestHash === requestHash) {
            // Same hash → return stored response immediately
            return {
              kind: 'idempotent_replay' as const,
              actorId: existing.actorId,
              actorKind: existing.actorKind,
              responsePayload: existing.responsePayload,
            };
          }
          // Different hash → conflict
          return { kind: 'idempotency_conflict' as const };
        }

        // 6. Re-lock blueprint row and recheck access
        const [lockedBp] = await tx
          .select()
          .from(blueprints)
          .where(eq(blueprints.id, bp.id))
          .for('update');

        if (!lockedBp) {
          return { kind: 'error' as const, code: BlueprintErrorCodes.NOT_FOUND, message: 'Blueprint not found' };
        }

        // Recheck lifecycle (delisted/archived)
        if (lockedBp.publicationStatus === 'delisted' || lockedBp.publicationStatus === 'archived') {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.LIFECYCLE_CONFLICT,
            message: 'Blueprint is delisted or archived',
          };
        }

        // 7. Revalidate skill portability (for agents with skill deps)
        if (bp.kind === 'agent') {
          const skillRefs = await getRevisionSkillRefs(tx as unknown as Database, revision.id);
          if (skillRefs.length > 0) {
            const portability = await validateSkillPortability(skillRefs, tx as unknown as Database);
            if (!portability.valid) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE,
                message: portability.errors.join('; '),
              };
            }
          }
        }

        // 8. Validate bindings
        if (parsed.data.bindings) {
          if (parsed.data.bindings.kind === 'agent' && 'connectionIds' in parsed.data.bindings) {
            const connIds = [...new Set(parsed.data.bindings.connectionIds)];
            if (connIds.length > 0) {
              // Query each connection individually to validate ownership and status
              for (const cid of connIds) {
                const [conn] = await tx
                  .select({ id: connections.id, userId: connections.userId, status: connections.status })
                  .from(connections)
                  .where(eq(connections.id, cid));
                if (!conn) {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.VALIDATION,
                    message: `Connection ${cid} not found`,
                  };
                }
                if (conn.status !== 'active') {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.VALIDATION,
                    message: `Connection ${cid} is not active`,
                  };
                }
                if (conn.userId !== request.userId) {
                  return {
                    kind: 'error' as const,
                    code: BlueprintErrorCodes.FORBIDDEN,
                    message: `Connection ${cid} does not belong to you`,
                  };
                }
              }
            }
          } else if (parsed.data.bindings.kind === 'bot') {
            const { connectionId, venueAccountId } = parsed.data.bindings as {
              kind: 'bot'; connectionId: string; venueAccountId: string;
            };
            const [conn] = await tx
              .select({ id: connections.id, userId: connections.userId, status: connections.status })
              .from(connections)
              .where(eq(connections.id, connectionId));
            if (!conn) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Connection ${connectionId} not found`,
              };
            }
            if (conn.status !== 'active') {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Connection ${connectionId} is not active`,
              };
            }
            if (conn.userId !== request.userId) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.FORBIDDEN,
                message: `Connection ${connectionId} does not belong to you`,
              };
            }
            const [va] = await tx
              .select({ id: venueAccounts.id, userId: venueAccounts.userId })
              .from(venueAccounts)
              .where(eq(venueAccounts.id, venueAccountId));
            if (!va) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.VALIDATION,
                message: `Venue account ${venueAccountId} not found`,
              };
            }
            if (va.userId !== request.userId) {
              return {
                kind: 'error' as const,
                code: BlueprintErrorCodes.FORBIDDEN,
                message: `Venue account ${venueAccountId} does not belong to you`,
              };
            }
          }
        }

        // 9. Resolve execution capability
        const agentPayload = rawPayload as AgentBlueprintRevisionPayload;
        const botPayload = rawPayload as BotBlueprintRevisionPayload;
        const rawExecDefaults2 = agentPayload.executionDefaults ?? botPayload.executionDefaults ?? null;
        const capabilityInput: BlueprintExecutionCapabilityInput = {
          kind: bp.kind as 'agent' | 'bot',
          tradingCapable: isTrading,
          executionDefaults: rawExecDefaults2 ? { mode: rawExecDefaults2.mode, slippageBps: rawExecDefaults2.slippageBps ?? 0 } : null,
          venue: botPayload.venue ?? (rawPayload.venue as string | null) ?? null,
          venueType: bp.venueType as 'orderbook' | 'swap' | null,
          swapAssets: botPayload.swapAssets ?? null,
          requestedMode: (parsed.data.requestedMode ?? null) as 'paper' | 'shadow' | 'live' | null,
          liveOptIn: parsed.data.liveOptIn ?? false,
          binding: parsed.data.bindings
            ? (parsed.data.bindings as { kind: 'agent'; connectionIds: string[] } | { kind: 'bot'; connectionId: string; venueAccountId: string })
            : null,
        };
        const capResult = await executionCapabilityResolver.resolve(capabilityInput);
        if (capResult.errors.length > 0) {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.VALIDATION,
            message: capResult.errors.join('; '),
          };
        }

        // H2: If the caller pinned an expected mode from preview, reject if re-resolution differs
        if (parsed.data.expectedMode && parsed.data.expectedMode !== capResult.resolvedMode) {
          return {
            kind: 'error' as const,
            code: BlueprintErrorCodes.MODE_CHANGED,
            message: `Resolved mode changed from ${parsed.data.expectedMode} to ${capResult.resolvedMode}. Re-run preview.`,
          };
        }

        // 10. Apply installer edits to produce final payload (deep-merge for object fields)
        let finalPayload: Record<string, unknown>;
        if (parsed.data.edits) {
          finalPayload = deepMergeEdits(rawPayload, parsed.data.edits);
        } else {
          finalPayload = { ...rawPayload };
        }

        // 11. Resolve effective risk and validate against operator ceilings
        // rawPayload is Record<string, unknown> from DB; resolveEffectiveRisk expects RiskPosture.
        const rawRisk = (rawPayload.risk ?? null) as import('@herobids/domain').RiskPosture | null;
        // parsed.data.edits is from the Zod-validated request — narrow by kind.
        const editsRisk = parsed.data.edits && parsed.data.edits.kind === 'agent'
          ? (parsed.data.edits as { risk?: Record<string, unknown> }).risk
          : undefined;
        const effectiveRisk = resolveEffectiveRisk(
          rawRisk,
          (editsRisk ?? null) as Partial<import('@herobids/domain').RiskPosture> | null,
          agentRiskDefaults,
        );
        // Reject if any user-provided risk value exceeds the operator ceiling
        for (const [fieldKey, fieldVal] of Object.entries(effectiveRisk)) {
          const f = fieldVal as { enforced: boolean; rawValue?: number | null; effectiveValue: number | null; operatorCeiling?: number | null };
          if (f.enforced && f.rawValue != null && f.effectiveValue != null && f.rawValue > f.effectiveValue) {
            return {
              kind: 'error' as const,
              code: BlueprintErrorCodes.VALIDATION,
              message: `Risk field "${fieldKey}" (${f.rawValue}) exceeds operator ceiling (${f.operatorCeiling}). Clamped to ${f.effectiveValue}.`,
            };
          }
        }

        // 12. Create STOPPED agent or bot with blueprint attribution
        if (bp.kind === 'agent') {
          const agentPayloadFinal = finalPayload as AgentBlueprintRevisionPayload;

          // Build unifiedConfig from blueprint agent fields that map to UnifiedAgentConfig
          const unifiedConfig: Record<string, unknown> = {};
          if (agentPayloadFinal.technical) unifiedConfig.technical = agentPayloadFinal.technical;
          if (agentPayloadFinal.intelligence) unifiedConfig.intelligence = agentPayloadFinal.intelligence;
          unifiedConfig.capabilityMode = agentPayloadFinal.capabilityMode;
          if (agentPayloadFinal.hybridMode) unifiedConfig.hybridMode = agentPayloadFinal.hybridMode;
          if (agentPayloadFinal.executionPolicy) {
            unifiedConfig.execution = {
              positionSizeMode: agentPayloadFinal.executionPolicy.positionSizeMode,
              fixedPositionSize: agentPayloadFinal.executionPolicy.fixedPositionSize,
            };
          }
          if (agentPayloadFinal.executionDefaults) {
            unifiedConfig.execution = {
              ...(isPlainObject(unifiedConfig.execution) ? unifiedConfig.execution : {}),
              mode: agentPayloadFinal.executionDefaults.mode,
            };
          }
          // Risk goes into unifiedConfig.risk (separate from direct risk column)
          if (finalPayload.risk) {
            unifiedConfig.risk = finalPayload.risk;
          }
          if (agentPayloadFinal.allowedPresets) unifiedConfig.allowedPresets = agentPayloadFinal.allowedPresets;
          if (agentPayloadFinal.presetTransition) unifiedConfig.presetTransition = agentPayloadFinal.presetTransition;
          if (agentPayloadFinal.platformAssessment) unifiedConfig.platformAssessment = agentPayloadFinal.platformAssessment;
          unifiedConfig.authorizationMode = agentPayloadFinal.authorizationMode ?? 'direct';

          await tx.insert(agents).values({
            id: actorId,
            userId: request.userId,
            name: agentPayloadFinal.name ?? bp.name,
            prompt: agentPayloadFinal.prompt ?? '',
            style: agentPayloadFinal.style,
            status: 'stopped',
            risk: (finalPayload.risk as import('@herobids/domain').RiskPosture) ?? null,
            strategy: agentPayloadFinal.strategy ?? null,
            executionDefaults: agentPayloadFinal.executionDefaults ?? null,
            capital: agentPayloadFinal.capital ?? null,
            maxBots: agentPayloadFinal.maxBots ?? null,
            tickIntervalMs: agentPayloadFinal.tickIntervalMs ?? null,
            toolPolicy: agentPayloadFinal.toolPolicy ?? null,
            modelPolicy: agentPayloadFinal.modelPolicy ?? null,
            openPositionEscalationToJudgePolicy: agentPayloadFinal.openPositionEscalationToJudgePolicy ?? 'uncovered_or_triggered',
            blueprintId: bp.id,
            blueprintRevisionId: revision.id,
            runtimePolicyOverrides: agentPayloadFinal.runtimePolicyOverrides ?? null,
            wakePreferences: agentPayloadFinal.wakePreferences ?? null,
            unifiedConfig: Object.keys(unifiedConfig).length > 0 ? unifiedConfig : null,
          } as typeof agents.$inferInsert);

          // Insert agent_skills rows
          const skillRefs = await getRevisionSkillRefs(tx as unknown as Database, revision.id);
          if (skillRefs.length > 0) {
            await tx.insert(agentSkills).values(
              skillRefs.map((s, i) => ({
                agentId: actorId,
                skillId: s.skillId,
                skillRevisionId: s.skillRevisionId,
                orderIndex: i,
                assignedByUserId: request.userId,
                assignmentSource: 'blueprint_instantiate',
              })),
            );
          }
        } else {
          // Bot creation
          const botPayloadFinal = finalPayload as BotBlueprintRevisionPayload;
          const binding = parsed.data.bindings as { kind: 'bot'; connectionId: string; venueAccountId: string };

          // Build bot config from payload
          const botConfig: Record<string, unknown> = {
            strategy: botPayloadFinal.strategy,
            risk: botPayloadFinal.risk,
            execution: {
              mode: capResult.resolvedMode ?? 'paper',
              slippageBps: botPayloadFinal.executionDefaults?.slippageBps,
            },
            tokenSafety: botPayloadFinal.tokenSafety,
            venue: botPayloadFinal.venue,
            venueType: botPayloadFinal.venueType,
            symbol: botPayloadFinal.symbol,
            swapAssets: botPayloadFinal.swapAssets,
            shadowPollIntervalMs: botPayloadFinal.shadowPollIntervalMs,
          };

          await tx.insert(bots).values({
            id: actorId,
            userId: request.userId,
            venueAccountId: binding.venueAccountId,
            connectionId: binding.connectionId,
            config: botConfig,
            blueprintId: bp.id,
            blueprintRevisionId: revision.id,
            configSnapshot: finalPayload,
            status: 'stopped',
            creatorType: 'user',
            creatorId: request.userId,
          } as typeof bots.$inferInsert);
        }

        // 13. Insert idempotency result
        const responsePayload: Record<string, unknown> = {
          actorId,
          actorKind: bp.kind,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          status: 'stopped',
          createdAt: now.toISOString(),
        };
        await tx.insert(blueprintInstantiationRequests).values({
          id: instantiationReqId,
          userId: request.userId,
          idempotencyKey: trimmedKey,
          requestHash,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          actorKind: bp.kind,
          actorId,
          responsePayload,
        });

        // 14. Emit usage event
        await tx.insert(blueprintUsageEvents).values({
          id: eventId,
          blueprintId: bp.id,
          blueprintRevisionId: revision.id,
          userId: request.userId,
          subjectKind: bp.kind,
          subjectId: actorId,
          eventType: 'instance_created',
          isSelfUsage: bp.authorId === request.userId,
          occurredAt: now,
          metadata: {
            idempotencyKey: trimmedKey,
            resolvedMode: capResult.resolvedMode,
          },
        });

        return {
          kind: 'created' as const,
          actorId,
          actorKind: bp.kind,
          responsePayload,
        };
      });

      // Handle transaction result
      if (result.kind === 'idempotent_replay') {
        return reply.status(200).send(result.responsePayload);
      }
      if (result.kind === 'idempotency_conflict') {
        return reply.status(409).send({
          error: BlueprintErrorCodes.IDEMPOTENCY_CONFLICT,
          message: 'Different request body for the same idempotency key',
        });
      }
      if (result.kind === 'error') {
        const status = result.code === BlueprintErrorCodes.NOT_FOUND ? 404
          : result.code === BlueprintErrorCodes.FORBIDDEN ? 403
          : result.code === BlueprintErrorCodes.DEPENDENCY_UNAVAILABLE ? 400
          : result.code === BlueprintErrorCodes.LIFECYCLE_CONFLICT ? 409
          : result.code === BlueprintErrorCodes.MODE_CHANGED ? 409
          : 400;
        return reply.status(status).send({ error: result.code, message: result.message });
      }

      return reply.status(201).send(result.responsePayload);
    },
  );
}
