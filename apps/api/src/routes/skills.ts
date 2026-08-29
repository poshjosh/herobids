import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import type { PlanSkillsEntitlements, PlansConfig } from '@herobids/domain';
import { findUnknownSkillTools, inferDependsOn, tokenize, expandToken } from '@herobids/domain';
import { agentSkills, agents, skillEntitlements, skillLikes, skillRevisions, skillUsageEvents, skills } from '@herobids/db';
import { resolvePlanSkillEntitlements } from '../plan-guards.js';

const PublicationStatusSchema = z.enum(['draft', 'private', 'published', 'delisted', 'archived']);

const CreateSkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  instructions: z.string().min(1).max(8000),
  promptHint: z.string().max(500).nullable().optional(),
  promptTemplate: z.string().max(4000).nullable().optional(),
  requiredTools: z.array(z.string()).optional().default([]),
  contextRequirements: z.array(z.string()).optional().default([]),
  requiredGuardrails: z.array(z.string()).optional().default([]),
  capabilityFamilies: z.array(z.string()).optional().default([]),
  suggestedTickIntervalMs: z.number().int().min(1_000).max(86_400_000).optional(),
  tags: z.array(z.string()).optional().default([]),
  priceCents: z.number().int().min(0).optional().default(0),
  publicationStatus: z.enum(['draft', 'private', 'published']).optional(),
  changeSummary: z.string().max(500).optional(),
});

const UpdateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000).optional(),
  instructions: z.string().min(1).max(8000).optional(),
  promptTemplate: z.string().max(4000).nullable().optional(),
  promptHint: z.string().max(500).nullable().optional(),
  requiredTools: z.array(z.string()).optional(),
  contextRequirements: z.array(z.string()).optional(),
  requiredGuardrails: z.array(z.string()).optional(),
  capabilityFamilies: z.array(z.string()).optional(),
  suggestedTickIntervalMs: z.number().int().min(1_000).max(86_400_000).nullable().optional(),
  tags: z.array(z.string()).optional(),
  priceCents: z.number().int().min(0).optional(),
  changeSummary: z.string().max(500).optional(),
});

const ListSkillsQuerySchema = z.object({
  scope: z.enum(['mine', 'marketplace', 'selectable', 'admin']).optional().default('selectable'),
  publicationStatus: PublicationStatusSchema.optional(),
  sort: z.enum(['popular', 'trending', 'newest', 'price_asc', 'price_desc']).optional(),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  likedByMe: z.coerce.boolean().optional(),
  tag: z.string().min(1).optional(),
  q: z.string().min(1).optional(),
});

const PublishSkillSchema = z.object({
  revisionId: z.string().min(1).optional(),
});

function buildUnknownToolValidationError(requiredTools: string[]) {
  const unknownTools = findUnknownSkillTools(requiredTools);
  if (unknownTools.length === 0) {
    return null;
  }

  return {
    error: 'validation_error',
    details: [{
      code: 'custom',
      path: ['requiredTools'],
      message: `Unknown requiredTools: ${unknownTools.join(', ')}`,
      params: {
        issueCode: 'skills.unknown_required_tools',
        unknownTools,
      },
    }],
  };
}

type ViewerSkillContext = {
  entitledSkillIds: Set<string>;
  assignedSkillIds: Set<string>;
  likedSkillIds: Set<string>;
};

type SelectabilityResult = {
  isSelectable: boolean;
  selectabilityReason: string;
};

type SkillView = {
  id: string;
  authorId: string | null;
  sourceKind: 'system' | 'user';
  publicationStatus: 'draft' | 'private' | 'published' | 'delisted' | 'archived';
  hasStagedRevision: boolean;
  priceCents: number;
  likeCount: number;
  forkCount: number;
  forkOf: string | null;
  popularityScore: number;
  trendingScore: number;
  isLikedByViewer: boolean;
  isSelectable: boolean;
  selectabilityReason: string;
  currentRevisionId: string | null;
  currentRevisionVersion: number | null;
  name: string;
  description: string;
  promptTemplate: string | null;
  instructions: string;
  promptHint: string | null;
  requiredTools: string[];
  contextRequirements: string[];
  requiredGuardrails: string[];
  capabilityFamilies: string[];
  suggestedTickIntervalMs: number | null;
  tags: string[];
  dependsOn: string[];
  createdAt: Date;
  updatedAt: Date;
};

function sourceKindForSkill(row: typeof skills.$inferSelect): 'system' | 'user' {
  return row.authorId === null ? 'system' : 'user';
}

function resolvePlanPolicy(plansConfig: PlansConfig | undefined, planId: string, isAdmin: boolean): PlanSkillsEntitlements {
  if (!plansConfig) {
    return {
      canCreatePrivateSkills: true,
      canViewMarketplaceSkills: true,
      canPublishToMarketplace: true,
      autoPublishNonDraftSkills: false,
      canPriceSkills: isAdmin,
      canLikeMarketplaceSkills: true,
    };
  }
  return resolvePlanSkillEntitlements(plansConfig, planId, isAdmin);
}

function resolveCreationPublicationStatus(
  requestedStatus: 'draft' | 'private' | 'published' | undefined,
  planPolicy: PlanSkillsEntitlements,
): {
  publicationStatus: 'draft' | 'private' | 'published';
  autoPublishedByPlan: boolean;
  requiresMarketplacePublish: boolean;
} {
  if (requestedStatus === 'draft') {
    return {
      publicationStatus: 'draft',
      autoPublishedByPlan: false,
      requiresMarketplacePublish: false,
    };
  }

  if (planPolicy.autoPublishNonDraftSkills) {
    return {
      publicationStatus: 'published',
      autoPublishedByPlan: true,
      requiresMarketplacePublish: true,
    };
  }

  if (requestedStatus === 'published') {
    if (planPolicy.canPublishToMarketplace) {
      return {
        publicationStatus: 'published',
        autoPublishedByPlan: false,
        requiresMarketplacePublish: true,
      };
    }

    if (planPolicy.canCreatePrivateSkills) {
      return {
        publicationStatus: 'private',
        autoPublishedByPlan: false,
        requiresMarketplacePublish: false,
      };
    }

    return {
      publicationStatus: 'published',
      autoPublishedByPlan: false,
      requiresMarketplacePublish: true,
    };
  }

  if (!planPolicy.canCreatePrivateSkills) {
    return {
      publicationStatus: 'published',
      autoPublishedByPlan: true,
      requiresMarketplacePublish: true,
    };
  }

  return {
    publicationStatus: 'private',
    autoPublishedByPlan: false,
    requiresMarketplacePublish: false,
  };
}

function evaluateSelectability(
  row: typeof skills.$inferSelect,
  viewerUserId: string,
  viewerContext: ViewerSkillContext,
  canViewMarketplaceSkills: boolean,
): SelectabilityResult {
  if (row.authorId === null) {
    return { isSelectable: true, selectabilityReason: 'system_skill' };
  }

  if (row.authorId === viewerUserId) {
    return { isSelectable: true, selectabilityReason: 'owner' };
  }

  if (viewerContext.assignedSkillIds.has(row.id)) {
    return { isSelectable: true, selectabilityReason: 'previously_assigned' };
  }

  if (viewerContext.entitledSkillIds.has(row.id)) {
    return { isSelectable: true, selectabilityReason: 'entitled' };
  }

  if (row.publicationStatus !== 'published') {
    return { isSelectable: false, selectabilityReason: 'not_published' };
  }

  if (!canViewMarketplaceSkills) {
    return { isSelectable: false, selectabilityReason: 'marketplace_hidden' };
  }

  if (row.priceCents === 0) {
    return { isSelectable: true, selectabilityReason: 'published_free' };
  }

  return { isSelectable: false, selectabilityReason: 'paid_entitlement_required' };
}

function scoreFromMetrics(metrics: {
  distinctUsers: number;
  likes: number;
  sessionStarts: number;
  forks: number;
}): number {
  return (0.45 * Math.log1p(metrics.distinctUsers))
    + (0.25 * Math.log1p(metrics.likes))
    + (0.20 * Math.log1p(metrics.sessionStarts))
    + (0.10 * Math.log1p(metrics.forks));
}

async function loadViewerContext(db: Database, userId: string, skillIds: string[]): Promise<ViewerSkillContext> {
  const entitlementRows = await db.select({ skillId: skillEntitlements.skillId })
    .from(skillEntitlements)
    .where(and(
      eq(skillEntitlements.userId, userId),
      isNull(skillEntitlements.revokedAt),
      skillIds.length > 0 ? inArray(skillEntitlements.skillId, skillIds) : sql`true`,
    ));

  const assignmentRows = await db.selectDistinct({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .innerJoin(agents, eq(agentSkills.agentId, agents.id))
    .where(and(
      eq(agents.userId, userId),
      skillIds.length > 0 ? inArray(agentSkills.skillId, skillIds) : sql`true`,
    ));

  const likeRows = await db.select({ skillId: skillLikes.skillId })
    .from(skillLikes)
    .where(and(
      eq(skillLikes.userId, userId),
      skillIds.length > 0 ? inArray(skillLikes.skillId, skillIds) : sql`true`,
    ));

  return {
    entitledSkillIds: new Set(entitlementRows.map((row) => row.skillId)),
    assignedSkillIds: new Set(assignmentRows.map((row) => row.skillId)),
    likedSkillIds: new Set(likeRows.map((row) => row.skillId)),
  };
}

async function getLatestRevisionBySkillId(db: Database, skillId: string) {
  const rows = await db.select().from(skillRevisions)
    .where(eq(skillRevisions.skillId, skillId))
    .orderBy(desc(skillRevisions.version))
    .limit(1);
  return rows[0] ?? null;
}

async function buildSkillViews(
  db: Database,
  rows: Array<typeof skills.$inferSelect>,
  viewerUserId: string,
  planPolicy: PlanSkillsEntitlements,
): Promise<SkillView[]> {
  if (rows.length === 0) return [];

  const skillIds = rows.map((row) => row.id);
  const revisionIds = rows.map((row) => row.currentRevisionId).filter((id): id is string => id !== null);
  const [revisionRows, viewerContext, latestVersionRows] = await Promise.all([
    revisionIds.length > 0
      ? db.select().from(skillRevisions).where(inArray(skillRevisions.id, revisionIds))
      : Promise.resolve([]),
    loadViewerContext(db, viewerUserId, skillIds),
    db.select({
      skillId: skillRevisions.skillId,
      latestVersion: sql<number>`MAX(${skillRevisions.version})`,
    }).from(skillRevisions)
      .where(inArray(skillRevisions.skillId, skillIds))
      .groupBy(skillRevisions.skillId),
  ]);

  const revisionById = new Map(revisionRows.map((row) => [row.id, row] as const));
  const latestVersionBySkillId = new Map(
    latestVersionRows.map((row) => [row.skillId, Number(row.latestVersion ?? 0)] as const),
  );
  const views: SkillView[] = [];

  for (const row of rows) {
    const currentRevision = row.currentRevisionId ? revisionById.get(row.currentRevisionId) : null;
    const latestVersion = latestVersionBySkillId.get(row.id) ?? 0;
    const currentRevisionVersion = currentRevision?.version ?? 0;
    const selectability = evaluateSelectability(row, viewerUserId, viewerContext, planPolicy.canViewMarketplaceSkills);
    views.push({
      id: row.id,
      authorId: row.authorId,
      sourceKind: sourceKindForSkill(row),
      publicationStatus: row.publicationStatus as SkillView['publicationStatus'],
      hasStagedRevision: latestVersion > currentRevisionVersion,
      priceCents: row.priceCents,
      likeCount: row.likeCount,
      forkCount: row.forkCount,
      forkOf: row.forkOf ?? null,
      popularityScore: row.popularityScore,
      trendingScore: row.trendingScore,
      isLikedByViewer: viewerContext.likedSkillIds.has(row.id),
      isSelectable: selectability.isSelectable,
      selectabilityReason: selectability.selectabilityReason,
      currentRevisionId: row.currentRevisionId,
      currentRevisionVersion: currentRevision?.version ?? null,
      name: currentRevision?.name ?? row.name,
      description: currentRevision?.description ?? row.description,
      instructions: currentRevision?.instructions ?? row.instructions,
      promptHint: currentRevision?.promptHint ?? row.promptHint ?? null,
      promptTemplate: currentRevision?.promptTemplate ?? row.promptTemplate ?? null,
      requiredTools: currentRevision?.requiredTools ?? row.requiredTools,
      contextRequirements: currentRevision?.contextRequirements ?? row.contextRequirements,
      requiredGuardrails: currentRevision?.requiredGuardrails ?? row.requiredGuardrails,
      capabilityFamilies: currentRevision?.capabilityFamilies ?? row.capabilityFamilies,
      suggestedTickIntervalMs: currentRevision?.suggestedTickIntervalMs ?? row.suggestedTickIntervalMs,
      tags: currentRevision?.tags ?? row.tags ?? [],
      dependsOn: inferDependsOn(currentRevision?.requiredTools ?? row.requiredTools, row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return views;
}

async function computeSkillMetrics(db: Database, skillId: string): Promise<{
  distinctUsers90d: number;
  likes90d: number;
  sessionStarts90d: number;
  forks90d: number;
  distinctUsers30d: number;
  likes30d: number;
  sessionStarts30d: number;
  forks30d: number;
}> {
  const [window90] = await db.execute(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN event_type = 'session_started' THEN user_id END)::int AS distinct_users_90d,
      COUNT(CASE WHEN event_type = 'session_started' THEN 1 END)::int AS session_starts_90d,
      COUNT(CASE WHEN event_type = 'fork_created' THEN 1 END)::int AS forks_90d
    FROM skill_usage_events
    WHERE skill_id = ${skillId}
      AND occurred_at >= (NOW() - INTERVAL '90 days')
  `);

  const [window30] = await db.execute(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN event_type = 'session_started' THEN user_id END)::int AS distinct_users_30d,
      COUNT(CASE WHEN event_type = 'session_started' THEN 1 END)::int AS session_starts_30d,
      COUNT(CASE WHEN event_type = 'fork_created' THEN 1 END)::int AS forks_30d
    FROM skill_usage_events
    WHERE skill_id = ${skillId}
      AND occurred_at >= (NOW() - INTERVAL '30 days')
  `);

  const [likes90] = await db.execute(sql`
    SELECT COUNT(*)::int AS likes_90d
    FROM skill_likes
    WHERE skill_id = ${skillId}
      AND created_at >= (NOW() - INTERVAL '90 days')
  `);

  const [likes30] = await db.execute(sql`
    SELECT COUNT(*)::int AS likes_30d
    FROM skill_likes
    WHERE skill_id = ${skillId}
      AND created_at >= (NOW() - INTERVAL '30 days')
  `);

  return {
    distinctUsers90d: Number(window90?.distinct_users_90d ?? 0),
    likes90d: Number(likes90?.likes_90d ?? 0),
    sessionStarts90d: Number(window90?.session_starts_90d ?? 0),
    forks90d: Number(window90?.forks_90d ?? 0),
    distinctUsers30d: Number(window30?.distinct_users_30d ?? 0),
    likes30d: Number(likes30?.likes_30d ?? 0),
    sessionStarts30d: Number(window30?.session_starts_30d ?? 0),
    forks30d: Number(window30?.forks_30d ?? 0),
  };
}

async function recomputeSkillScores(db: Database, skillId: string): Promise<void> {
  const metrics = await computeSkillMetrics(db, skillId);
  const popularityScore = scoreFromMetrics({
    distinctUsers: metrics.distinctUsers90d,
    likes: metrics.likes90d,
    sessionStarts: metrics.sessionStarts90d,
    forks: metrics.forks90d,
  });
  const trendingScore = scoreFromMetrics({
    distinctUsers: metrics.distinctUsers30d,
    likes: metrics.likes30d,
    sessionStarts: metrics.sessionStarts30d,
    forks: metrics.forks30d,
  });

  await db.update(skills).set({
    popularityScore,
    trendingScore,
    updatedAt: new Date(),
  }).where(eq(skills.id, skillId));
}

async function recomputeAllSkillScores(db: Database): Promise<void> {
  const rows = await db.select({ id: skills.id }).from(skills);
  for (const row of rows) {
    await recomputeSkillScores(db, row.id);
  }
}

async function refreshLikeCount(db: Database, skillId: string): Promise<number> {
  const [countRow] = await db.execute(sql`
    SELECT COUNT(*)::int AS like_count
    FROM skill_likes
    WHERE skill_id = ${skillId}
  `);
  const likeCount = Number(countRow?.like_count ?? 0);
  await db.update(skills).set({ likeCount, updatedAt: new Date() }).where(eq(skills.id, skillId));
  return likeCount;
}

function hasContentChange(
  currentRevision: typeof skillRevisions.$inferSelect,
  updates: z.infer<typeof UpdateSkillSchema>,
): boolean {
  return updates.name !== undefined
    || updates.description !== undefined
    || updates.instructions !== undefined
    || updates.promptHint !== undefined
    || updates.promptTemplate !== undefined
    || updates.requiredTools !== undefined
    || updates.contextRequirements !== undefined
    || updates.requiredGuardrails !== undefined
    || updates.capabilityFamilies !== undefined
    || updates.suggestedTickIntervalMs !== undefined
    || updates.tags !== undefined
    || currentRevision.name !== (updates.name ?? currentRevision.name)
    || currentRevision.description !== (updates.description ?? currentRevision.description)
    || currentRevision.instructions !== (updates.instructions ?? currentRevision.instructions)
    || (currentRevision.promptHint ?? null) !== ((updates.promptHint === undefined ? currentRevision.promptHint : updates.promptHint) ?? null)
    || (currentRevision.promptTemplate ?? null) !== ((updates.promptTemplate === undefined ? currentRevision.promptTemplate : updates.promptTemplate) ?? null)
    || JSON.stringify(currentRevision.requiredTools) !== JSON.stringify(updates.requiredTools ?? currentRevision.requiredTools)
    || JSON.stringify(currentRevision.contextRequirements) !== JSON.stringify(updates.contextRequirements ?? currentRevision.contextRequirements)
    || JSON.stringify(currentRevision.requiredGuardrails) !== JSON.stringify(updates.requiredGuardrails ?? currentRevision.requiredGuardrails)
    || JSON.stringify(currentRevision.capabilityFamilies) !== JSON.stringify(updates.capabilityFamilies ?? currentRevision.capabilityFamilies)
    || (currentRevision.suggestedTickIntervalMs ?? null) !== (updates.suggestedTickIntervalMs === undefined ? (currentRevision.suggestedTickIntervalMs ?? null) : updates.suggestedTickIntervalMs)
    || JSON.stringify(currentRevision.tags) !== JSON.stringify(updates.tags ?? currentRevision.tags);
}

export async function skillsRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  const scoreRefreshTimer = setInterval(() => {
    void recomputeAllSkillScores(db).catch((error: unknown) => {
      app.log.error({ err: error }, '[skills] failed periodic score recomputation');
    });
  }, 60 * 60 * 1000);
  app.addHook('onClose', async () => {
    clearInterval(scoreRefreshTimer);
  });

  app.get<{ Querystring: unknown }>('/skills', async (request, reply) => {
    const parsed = ListSkillsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const query = parsed.data;
    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);

    if (query.scope === 'marketplace' && !request.isAdmin && !planPolicy.canViewMarketplaceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_hidden',
        message: 'Your plan does not include marketplace access',
      });
    }

    if (query.scope === 'admin' && !request.isAdmin) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const whereClauses: SQL[] = [];
    if (query.scope === 'mine') {
      whereClauses.push(eq(skills.authorId, request.userId));
    } else if (query.scope === 'marketplace') {
      whereClauses.push(and(sql`${skills.authorId} IS NOT NULL`, eq(skills.publicationStatus, 'published'))!);
    } else if (query.scope === 'selectable') {
      const [entitlementRows, assignmentRows] = await Promise.all([
        db.select({ skillId: skillEntitlements.skillId })
          .from(skillEntitlements)
          .where(and(eq(skillEntitlements.userId, request.userId), isNull(skillEntitlements.revokedAt))),
        db.selectDistinct({ skillId: agentSkills.skillId })
          .from(agentSkills)
          .innerJoin(agents, eq(agentSkills.agentId, agents.id))
          .where(eq(agents.userId, request.userId)),
      ]);
      const explicitlySelectableIds = [...new Set([
        ...entitlementRows.map((row) => row.skillId),
        ...assignmentRows.map((row) => row.skillId),
      ])];

      whereClauses.push(or(
        sql`${skills.authorId} IS NULL`,
        eq(skills.authorId, request.userId),
        planPolicy.canViewMarketplaceSkills ? eq(skills.publicationStatus, 'published') : sql`false`,
        explicitlySelectableIds.length > 0 ? inArray(skills.id, explicitlySelectableIds) : sql`false`,
      )!);
    }

    if (query.publicationStatus) {
      whereClauses.push(eq(skills.publicationStatus, query.publicationStatus));
    }

    if (query.priceMin !== undefined) {
      whereClauses.push(gte(skills.priceCents, query.priceMin));
    }

    if (query.priceMax !== undefined) {
      whereClauses.push(lte(skills.priceCents, query.priceMax));
    }

    if (query.tag) {
      whereClauses.push(sql`${query.tag} = ANY(${skills.tags})`);
    }

    if (query.q) {
      const tokens = tokenize(query.q);
      if (tokens.length > 0) {
        const tokenClauses = tokens.flatMap(t => expandToken(t)).map(form => {
          const pattern = `%${form}%`;
          return or(
            ilike(skills.name, pattern),
            ilike(skills.description, pattern),
            sql`EXISTS (SELECT 1 FROM unnest(${skills.tags}) tag WHERE tag ILIKE ${pattern})`,
          );
        });
        whereClauses.push(or(...tokenClauses)!);
      }
    }

    let rowsQuery = db.select().from(skills).$dynamic();
    if (whereClauses.length === 1) {
      rowsQuery = rowsQuery.where(whereClauses[0]!);
    } else if (whereClauses.length > 1) {
      rowsQuery = rowsQuery.where(and(...whereClauses)!);
    }

    if (query.sort === 'price_asc') {
      rowsQuery = rowsQuery.orderBy(asc(skills.priceCents), desc(skills.popularityScore));
    } else if (query.sort === 'price_desc') {
      rowsQuery = rowsQuery.orderBy(desc(skills.priceCents), desc(skills.popularityScore));
    } else if (query.sort === 'trending') {
      rowsQuery = rowsQuery.orderBy(desc(skills.trendingScore), desc(skills.popularityScore));
    } else if (query.sort === 'newest') {
      rowsQuery = rowsQuery.orderBy(desc(skills.createdAt));
    } else {
      rowsQuery = rowsQuery.orderBy(desc(skills.popularityScore), desc(skills.createdAt));
    }

    const rows = await rowsQuery;
    let views = await buildSkillViews(db, rows, request.userId, planPolicy);

    if (query.scope === 'selectable') {
      views = views.filter((skill) => skill.isSelectable);
    }

    if (query.likedByMe === true) {
      views = views.filter((skill) => skill.isLikedByViewer);
    }

    if (query.scope === 'marketplace') {
      views = views.filter((skill) => skill.sourceKind === 'user' && skill.publicationStatus === 'published');
    }

    return reply.send({ skills: views });
  });

  app.post<{ Body: unknown }>('/skills', async (request, reply) => {
    const parsed = CreateSkillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const unknownToolError = buildUnknownToolValidationError(parsed.data.requiredTools);
    if (unknownToolError) {
      return reply.status(400).send(unknownToolError);
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (parsed.data.priceCents > 0 && !planPolicy.canPriceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_pricing_disabled',
        message: 'Your plan does not allow pricing skills',
      });
    }

    const publication = resolveCreationPublicationStatus(parsed.data.publicationStatus, planPolicy);
    if (publication.requiresMarketplacePublish && !planPolicy.canPublishToMarketplace) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_publish_disabled',
        message: 'Your plan does not allow publishing skills to the marketplace',
      });
    }

    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const createdAt = new Date();

    await db.transaction(async (tx) => {
      // Step 1: Insert skills row with null FK pointers to avoid circular FK
      // (published_revision_id → skill_revisions.id). Revision inserted next,
      // then the FK pointers are patched in step 3.
      await tx.insert(skills).values({
        id,
        authorId: request.userId,
        publicationStatus: publication.publicationStatus,
        publishedAt: publication.publicationStatus === 'published' ? createdAt : null,
        currentRevisionId: null,
        publishedRevisionId: null,
        priceCents: parsed.data.priceCents,
        autoPublishedByPlan: publication.autoPublishedByPlan,
        name: parsed.data.name,
        description: parsed.data.description,
        instructions: parsed.data.instructions,
        promptHint: parsed.data.promptHint ?? null,
        promptTemplate: parsed.data.promptTemplate ?? null,
        requiredTools: parsed.data.requiredTools,
        contextRequirements: parsed.data.contextRequirements,
        requiredGuardrails: parsed.data.requiredGuardrails,
        capabilityFamilies: parsed.data.capabilityFamilies,
        suggestedTickIntervalMs: parsed.data.suggestedTickIntervalMs ?? 900_000,
        tags: parsed.data.tags,
        createdAt,
        updatedAt: createdAt,
      });

      // Step 2: Insert the revision — now that the parent skills row exists
      await tx.insert(skillRevisions).values({
        id: revisionId,
        skillId: id,
        version: 1,
        name: parsed.data.name,
        description: parsed.data.description,
        instructions: parsed.data.instructions,
        promptHint: parsed.data.promptHint ?? null,
        promptTemplate: parsed.data.promptTemplate ?? null,
        requiredTools: parsed.data.requiredTools,
        contextRequirements: parsed.data.contextRequirements,
        requiredGuardrails: parsed.data.requiredGuardrails,
        capabilityFamilies: parsed.data.capabilityFamilies,
        suggestedTickIntervalMs: parsed.data.suggestedTickIntervalMs ?? 900_000,
        tags: parsed.data.tags,
        changeSummary: parsed.data.changeSummary ?? null,
        createdByUserId: request.userId,
        publishedAt: publication.publicationStatus === 'published' ? createdAt : null,
        createdAt,
      });

      // Step 3: Patch FK pointers now that the revision exists
      await tx.update(skills)
        .set({
          currentRevisionId: revisionId,
          publishedRevisionId: publication.publicationStatus === 'published' ? revisionId : null,
          updatedAt: createdAt,
        })
        .where(eq(skills.id, id));
    });

    const [createdSkill] = await db.select().from(skills).where(eq(skills.id, id));
    const [view] = await buildSkillViews(db, [createdSkill!], request.userId, planPolicy);
    return reply.status(201).send(view);
  });

  app.get<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const { id } = request.params;
    const [row] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });

    if (!request.isAdmin) {
      const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
      const [view] = await buildSkillViews(db, [row], request.userId, planPolicy);
      if (!view) return reply.status(500).send({ error: 'internal' });
      const canView = view.sourceKind === 'system'
        || row.authorId === request.userId
        || view.isSelectable
        || (row.publicationStatus === 'published' && row.priceCents === 0 && planPolicy.canViewMarketplaceSkills);
      if (!canView) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.send(view);
    }

    const [adminView] = await buildSkillViews(db, [row], request.userId, {
      canCreatePrivateSkills: true,
      canViewMarketplaceSkills: true,
      canPublishToMarketplace: true,
      autoPublishNonDraftSkills: false,
      canPriceSkills: true,
      canLikeMarketplaceSkills: true,
    });
    return reply.send(adminView);
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/skills/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateSkillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    if (parsed.data.requiredTools) {
      const unknownToolError = buildUnknownToolValidationError(parsed.data.requiredTools);
      if (unknownToolError) {
        return reply.status(400).send(unknownToolError);
      }
    }

    const [row] = await db.select().from(skills)
      .where(and(eq(skills.id, id), eq(skills.authorId, request.userId)))
      .limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    const nextPriceCents = parsed.data.priceCents ?? row.priceCents;
    if (nextPriceCents > 0 && !planPolicy.canPriceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_pricing_disabled',
        message: 'Your plan does not allow pricing skills',
      });
    }

    const currentRevision = row.currentRevisionId
      ? (await db.select().from(skillRevisions).where(eq(skillRevisions.id, row.currentRevisionId)).limit(1))[0]
      : null;
    if (!currentRevision) {
      return reply.status(409).send({ error: 'invalid_state', message: 'Skill has no current revision' });
    }

    const contentChanged = hasContentChange(currentRevision, parsed.data);
    let stagedRevisionId: string | null = null;
    let promotedRevisionId: string | null = null;
    const now = new Date();

    await db.transaction(async (tx) => {
      if (contentChanged) {
        const latestRevision = await getLatestRevisionBySkillId(tx as unknown as Database, row.id);
        const version = (latestRevision?.version ?? 0) + 1;
        stagedRevisionId = crypto.randomUUID();
        await tx.insert(skillRevisions).values({
          id: stagedRevisionId,
          skillId: row.id,
          version,
          name: parsed.data.name ?? currentRevision.name,
          description: parsed.data.description ?? currentRevision.description,
          instructions: parsed.data.instructions ?? currentRevision.instructions,
          promptHint: parsed.data.promptHint === undefined ? currentRevision.promptHint : parsed.data.promptHint,
          promptTemplate: parsed.data.promptTemplate === undefined ? currentRevision.promptTemplate : parsed.data.promptTemplate,
          requiredTools: parsed.data.requiredTools ?? currentRevision.requiredTools,
          contextRequirements: parsed.data.contextRequirements ?? currentRevision.contextRequirements,
          requiredGuardrails: parsed.data.requiredGuardrails ?? currentRevision.requiredGuardrails,
          capabilityFamilies: parsed.data.capabilityFamilies ?? currentRevision.capabilityFamilies,
          suggestedTickIntervalMs: parsed.data.suggestedTickIntervalMs === undefined
            ? currentRevision.suggestedTickIntervalMs
            : parsed.data.suggestedTickIntervalMs,
          tags: parsed.data.tags ?? currentRevision.tags,
          changeSummary: parsed.data.changeSummary ?? null,
          createdByUserId: request.userId,
          createdAt: now,
        });

        if (row.publicationStatus !== 'published') {
          promotedRevisionId = stagedRevisionId;
        }
      }

      const updatePayload: Record<string, unknown> = {
        priceCents: nextPriceCents,
        updatedAt: now,
      };

      if (promotedRevisionId) {
        updatePayload['currentRevisionId'] = promotedRevisionId;
        const promotedRevision = await tx.select().from(skillRevisions)
          .where(eq(skillRevisions.id, promotedRevisionId))
          .limit(1);
        const promoted = promotedRevision[0]!;
        updatePayload['name'] = promoted.name;
        updatePayload['description'] = promoted.description;
        updatePayload['instructions'] = promoted.instructions;
        updatePayload['promptHint'] = promoted.promptHint;
        updatePayload['promptTemplate'] = promoted.promptTemplate;
        updatePayload['requiredTools'] = promoted.requiredTools;
        updatePayload['contextRequirements'] = promoted.contextRequirements;
        updatePayload['requiredGuardrails'] = promoted.requiredGuardrails;
        updatePayload['capabilityFamilies'] = promoted.capabilityFamilies;
        updatePayload['suggestedTickIntervalMs'] = promoted.suggestedTickIntervalMs;
        updatePayload['tags'] = promoted.tags;
      }

      await tx.update(skills).set(updatePayload).where(eq(skills.id, row.id));
    });

    const [updatedRow] = await db.select().from(skills).where(eq(skills.id, row.id)).limit(1);
    const [view] = await buildSkillViews(db, [updatedRow!], request.userId, planPolicy);
    return reply.send({ ...view, stagedRevisionId });
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/skills/:id/publish', async (request, reply) => {
    const parsedBody = PublishSkillSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsedBody.error.issues });
    }

    const [row] = await db.select().from(skills)
      .where(and(eq(skills.id, request.params.id), eq(skills.authorId, request.userId)))
      .limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canPublishToMarketplace) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_publish_disabled',
        message: 'Your plan does not allow publishing skills to the marketplace',
      });
    }

    if (row.priceCents > 0 && !planPolicy.canPriceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_pricing_disabled',
        message: 'Your plan does not allow pricing skills',
      });
    }

    const targetRevision = parsedBody.data.revisionId
      ? (await db.select().from(skillRevisions).where(and(
        eq(skillRevisions.id, parsedBody.data.revisionId),
        eq(skillRevisions.skillId, row.id),
      )).limit(1))[0]
      : await getLatestRevisionBySkillId(db, row.id);
    if (!targetRevision) {
      return reply.status(409).send({ error: 'invalid_state', message: 'No revision available to publish' });
    }

    const publishTime = new Date();

    await db.transaction(async (tx) => {
      // Set publishedRevisionId on the skill and mark the revision as published
      await tx.update(skillRevisions).set({
        publishedAt: publishTime,
      }).where(eq(skillRevisions.id, targetRevision.id));

      await tx.update(skills).set({
        publicationStatus: 'published',
        publishedAt: publishTime,
        publishedRevisionId: targetRevision.id,
        delistedAt: null,
        archivedAt: null,
        currentRevisionId: targetRevision.id,
        name: targetRevision.name,
        description: targetRevision.description,
        instructions: targetRevision.instructions,
        promptHint: targetRevision.promptHint,
        promptTemplate: targetRevision.promptTemplate,
        requiredTools: targetRevision.requiredTools,
        contextRequirements: targetRevision.contextRequirements,
        requiredGuardrails: targetRevision.requiredGuardrails,
        capabilityFamilies: targetRevision.capabilityFamilies,
        suggestedTickIntervalMs: targetRevision.suggestedTickIntervalMs,
        tags: targetRevision.tags,
        updatedAt: publishTime,
      }).where(eq(skills.id, row.id));
    });

    const [publishedRow] = await db.select().from(skills).where(eq(skills.id, row.id)).limit(1);
    const [view] = await buildSkillViews(db, [publishedRow!], request.userId, planPolicy);
    return reply.send(view);
  });

  app.post<{ Params: { id: string } }>('/skills/:id/delist', async (request, reply) => {
    const [row] = await db.select().from(skills)
      .where(and(eq(skills.id, request.params.id), eq(skills.authorId, request.userId)))
      .limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canCreatePrivateSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_private_disabled',
        message: 'Your plan does not allow private skills',
      });
    }

    await db.update(skills).set({
      publicationStatus: 'delisted',
      delistedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(skills.id, row.id));

    const [delistedRow] = await db.select().from(skills).where(eq(skills.id, row.id)).limit(1);
    const [view] = await buildSkillViews(db, [delistedRow!], request.userId, planPolicy);
    return reply.send(view);
  });

  app.delete<{ Params: { id: string } }>('/skills/:id', async (request, reply) => {
    const [row] = await db.select().from(skills)
      .where(and(eq(skills.id, request.params.id), eq(skills.authorId, request.userId)))
      .limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const [referenceCount] = await db.execute(sql`
      SELECT COUNT(*)::int AS refs
      FROM agent_skills
      WHERE skill_id = ${row.id}
    `);
    const hasReferences = Number(referenceCount?.refs ?? 0) > 0;
    const canHardDelete = row.publicationStatus === 'draft' && row.publishedAt === null && !hasReferences;

    if (canHardDelete) {
      await db.delete(skills).where(eq(skills.id, row.id));
      return reply.status(204).send();
    }

    await db.update(skills).set({
      publicationStatus: 'archived',
      archivedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(skills.id, row.id));

    return reply.status(200).send({ status: 'archived' });
  });

  app.post<{ Params: { id: string } }>('/skills/:id/fork', async (request, reply) => {
    const { id } = request.params;
    const [source] = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!source) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    const [sourceView] = await buildSkillViews(db, [source], request.userId, planPolicy);
    if (!sourceView) return reply.status(500).send({ error: 'internal' });
    const canFork = source.authorId === null
      || source.authorId === request.userId
      || (source.publicationStatus === 'published' && planPolicy.canViewMarketplaceSkills)
      || sourceView.isSelectable;
    if (!canFork) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const sourceRevision = source.currentRevisionId
      ? (await db.select().from(skillRevisions).where(eq(skillRevisions.id, source.currentRevisionId)).limit(1))[0]
      : await getLatestRevisionBySkillId(db, source.id);
    if (!sourceRevision) {
      return reply.status(409).send({ error: 'invalid_state', message: 'Source skill has no revision' });
    }

    const unknownToolError = buildUnknownToolValidationError(sourceRevision.requiredTools);
    if (unknownToolError) {
      return reply.status(400).send(unknownToolError);
    }

    const publication = resolveCreationPublicationStatus(
      planPolicy.autoPublishNonDraftSkills ? 'published' : 'draft',
      planPolicy,
    );
    if (publication.requiresMarketplacePublish && !planPolicy.canPublishToMarketplace) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_publish_disabled',
        message: 'Your plan does not allow publishing skills to the marketplace',
      });
    }

    const forkId = crypto.randomUUID();
    const forkRevisionId = crypto.randomUUID();
    const now = new Date();
    await db.transaction(async (tx) => {
      // Step 1: Insert skills row with null FK pointers (published_revision_id → skill_revisions.id)
      await tx.insert(skills).values({
        id: forkId,
        authorId: request.userId,
        publicationStatus: publication.publicationStatus,
        publishedAt: publication.publicationStatus === 'published' ? now : null,
        currentRevisionId: null,
        publishedRevisionId: null,
        priceCents: 0,
        autoPublishedByPlan: publication.autoPublishedByPlan,
        name: `${sourceRevision.name} (copy)`,
        description: sourceRevision.description,
        instructions: sourceRevision.instructions,
        promptHint: sourceRevision.promptHint ?? null,
        promptTemplate: sourceRevision.promptTemplate ?? null,
        requiredTools: sourceRevision.requiredTools,
        contextRequirements: sourceRevision.contextRequirements,
        requiredGuardrails: sourceRevision.requiredGuardrails,
        capabilityFamilies: sourceRevision.capabilityFamilies,
        suggestedTickIntervalMs: sourceRevision.suggestedTickIntervalMs,
        tags: sourceRevision.tags,
        forkOf: source.id,
        createdAt: now,
        updatedAt: now,
      });

      // Step 2: Insert the revision
      await tx.insert(skillRevisions).values({
        id: forkRevisionId,
        skillId: forkId,
        version: 1,
        name: `${sourceRevision.name} (copy)`,
        description: sourceRevision.description,
        instructions: sourceRevision.instructions,
        promptHint: sourceRevision.promptHint ?? null,
        promptTemplate: sourceRevision.promptTemplate ?? null,
        requiredTools: sourceRevision.requiredTools,
        contextRequirements: sourceRevision.contextRequirements,
        requiredGuardrails: sourceRevision.requiredGuardrails,
        capabilityFamilies: sourceRevision.capabilityFamilies,
        suggestedTickIntervalMs: sourceRevision.suggestedTickIntervalMs,
        tags: sourceRevision.tags,
        changeSummary: 'forked skill',
        createdByUserId: request.userId,
        publishedAt: publication.publicationStatus === 'published' ? now : null,
        createdAt: now,
      });

      // Step 3: Patch FK pointers now that the revision exists
      await tx.update(skills)
        .set({
          currentRevisionId: forkRevisionId,
          publishedRevisionId: publication.publicationStatus === 'published' ? forkRevisionId : null,
          updatedAt: now,
        })
        .where(eq(skills.id, forkId));

      await tx.update(skills).set({
        forkCount: sql`${skills.forkCount} + 1`,
        updatedAt: now,
      }).where(eq(skills.id, source.id));

      await tx.insert(skillUsageEvents).values({
        id: crypto.randomUUID(),
        skillId: source.id,
        skillRevisionId: source.currentRevisionId ?? sourceRevision.id,
        userId: request.userId,
        agentId: null,
        sessionId: null,
        eventType: 'fork_created',
        occurredAt: now,
        metadata: { forkSkillId: forkId },
        createdAt: now,
      });
    });

    await recomputeSkillScores(db, source.id);

    const [forked] = await db.select().from(skills).where(eq(skills.id, forkId)).limit(1);
    const [view] = await buildSkillViews(db, [forked!], request.userId, planPolicy);
    return reply.status(201).send(view);
  });

  app.post<{ Params: { id: string } }>('/skills/:id/like', async (request, reply) => {
    const [row] = await db.select().from(skills).where(eq(skills.id, request.params.id)).limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canViewMarketplaceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_hidden',
        message: 'Your plan does not include marketplace access',
      });
    }

    if (!planPolicy.canLikeMarketplaceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_like_disabled',
        message: 'Your plan does not allow liking marketplace skills',
      });
    }

    if (row.authorId === null || row.publicationStatus !== 'published') {
      return reply.status(409).send({ error: 'invalid_target', message: 'Only published user-authored skills can be liked' });
    }

    if (row.authorId === request.userId) {
      return reply.status(403).send({ error: 'forbidden', message: 'Authors cannot like their own skills' });
    }

    await db.insert(skillLikes).values({
      skillId: row.id,
      userId: request.userId,
      createdAt: new Date(),
    }).onConflictDoNothing();

    const likeCount = await refreshLikeCount(db, row.id);
    await recomputeSkillScores(db, row.id);
    return reply.send({ liked: true, likeCount });
  });

  app.delete<{ Params: { id: string } }>('/skills/:id/like', async (request, reply) => {
    const [row] = await db.select().from(skills).where(eq(skills.id, request.params.id)).limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canViewMarketplaceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_marketplace_hidden',
        message: 'Your plan does not include marketplace access',
      });
    }

    if (!planPolicy.canLikeMarketplaceSkills) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.skills_like_disabled',
        message: 'Your plan does not allow liking marketplace skills',
      });
    }

    await db.delete(skillLikes).where(and(
      eq(skillLikes.skillId, row.id),
      eq(skillLikes.userId, request.userId),
    ));

    const likeCount = await refreshLikeCount(db, row.id);
    await recomputeSkillScores(db, row.id);
    return reply.send({ liked: false, likeCount });
  });

  app.get<{ Params: { id: string } }>('/skills/:id/metrics', async (request, reply) => {
    const [row] = await db.select().from(skills).where(eq(skills.id, request.params.id)).limit(1);
    if (!row) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const planPolicy = resolvePlanPolicy(plansConfig, request.userPlanId || 'free', request.isAdmin);
    if (!request.isAdmin && row.authorId !== request.userId && (
      row.publicationStatus !== 'published' || !planPolicy.canViewMarketplaceSkills
    )) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const metrics = await computeSkillMetrics(db, row.id);
    return reply.send({
      skillId: row.id,
      usage90d: metrics.sessionStarts90d,
      likes90d: metrics.likes90d,
      forks90d: metrics.forks90d,
      usage30d: metrics.sessionStarts30d,
      likes30d: metrics.likes30d,
      forks30d: metrics.forks30d,
      likeCount: row.likeCount,
      forkCount: row.forkCount,
      popularityScore: row.popularityScore,
      trendingScore: row.trendingScore,
      updatedAt: row.updatedAt,
    });
  });
}
