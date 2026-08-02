import { sql, eq } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints } from '@herobids/db';

/**
 * Score formula — mirrors skills scoring exactly.
 * Phase 1 uses the same logarithmic weighting as skills.
 */
export function scoreFromMetrics(metrics: {
  distinctUsers: number;
  likes: number;
  instances: number;
  forks: number;
}): number {
  return (0.45 * Math.log1p(metrics.distinctUsers))
    + (0.25 * Math.log1p(metrics.likes))
    + (0.20 * Math.log1p(metrics.instances))
    + (0.10 * Math.log1p(metrics.forks));
}

/**
 * Compute blueprint metrics within two time windows (90d + 30d).
 * Excludes self-usage (authorId events) from distinctUsers, instances, and forks.
 * Likes from the author themselves are impossible because author self-like is rejected.
 */
export async function computeBlueprintMetrics(
  db: Database,
  blueprintId: string,
  _authorId: string,
): Promise<{
  distinctUsers90d: number;
  likes90d: number;
  instances90d: number;
  forks90d: number;
  distinctUsers30d: number;
  likes30d: number;
  instances30d: number;
  forks30d: number;
}> {
  // Usage events within 90d (non-self)
  const [window90] = await db.execute(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN event_type IN ('instance_created', 'fork_created') THEN user_id END)::int AS distinct_users_90d,
      COUNT(CASE WHEN event_type = 'instance_created' THEN 1 END)::int AS instances_90d,
      COUNT(CASE WHEN event_type = 'fork_created' THEN 1 END)::int AS forks_90d
    FROM blueprint_usage_events
    WHERE blueprint_id = ${blueprintId}
      AND is_self_usage = false
      AND occurred_at >= (NOW() - INTERVAL '90 days')
  `);

  // Usage events within 30d (non-self)
  const [window30] = await db.execute(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN event_type IN ('instance_created', 'fork_created') THEN user_id END)::int AS distinct_users_30d,
      COUNT(CASE WHEN event_type = 'instance_created' THEN 1 END)::int AS instances_30d,
      COUNT(CASE WHEN event_type = 'fork_created' THEN 1 END)::int AS forks_30d
    FROM blueprint_usage_events
    WHERE blueprint_id = ${blueprintId}
      AND is_self_usage = false
      AND occurred_at >= (NOW() - INTERVAL '30 days')
  `);

  // Likes within 90d
  const [likes90] = await db.execute(sql`
    SELECT COUNT(*)::int AS likes_90d
    FROM blueprint_likes
    WHERE blueprint_id = ${blueprintId}
      AND created_at >= (NOW() - INTERVAL '90 days')
  `);

  // Likes within 30d
  const [likes30] = await db.execute(sql`
    SELECT COUNT(*)::int AS likes_30d
    FROM blueprint_likes
    WHERE blueprint_id = ${blueprintId}
      AND created_at >= (NOW() - INTERVAL '30 days')
  `);

  return {
    distinctUsers90d: Number(window90?.distinct_users_90d ?? 0),
    likes90d: Number(likes90?.likes_90d ?? 0),
    instances90d: Number(window90?.instances_90d ?? 0),
    forks90d: Number(window90?.forks_90d ?? 0),
    distinctUsers30d: Number(window30?.distinct_users_30d ?? 0),
    likes30d: Number(likes30?.likes_30d ?? 0),
    instances30d: Number(window30?.instances_30d ?? 0),
    forks30d: Number(window30?.forks_30d ?? 0),
  };
}

/**
 * Recompute popularity (90-day) and trending (30-day) scores for a blueprint.
 */
export async function recomputeBlueprintScores(db: Database, blueprintId: string): Promise<void> {
  const [bp] = await db.select({ authorId: blueprints.authorId })
    .from(blueprints)
    .where(eq(blueprints.id, blueprintId))
    .limit(1);
  if (!bp) return;

  const metrics = await computeBlueprintMetrics(db, blueprintId, bp.authorId);

  const popularityScore = scoreFromMetrics({
    distinctUsers: metrics.distinctUsers90d,
    likes: metrics.likes90d,
    instances: metrics.instances90d,
    forks: metrics.forks90d,
  });

  const trendingScore = scoreFromMetrics({
    distinctUsers: metrics.distinctUsers30d,
    likes: metrics.likes30d,
    instances: metrics.instances30d,
    forks: metrics.forks30d,
  });

  await db.update(blueprints).set({
    popularityScore,
    trendingScore,
    updatedAt: new Date(),
  }).where(eq(blueprints.id, blueprintId));
}

/**
 * Refresh the like count from blueprint_likes and update the blueprint row.
 * Returns the authoritative count.
 */
export async function refreshLikeCount(db: Database, blueprintId: string): Promise<number> {
  const [countRow] = await db.execute(sql`
    SELECT COUNT(*)::int AS like_count
    FROM blueprint_likes
    WHERE blueprint_id = ${blueprintId}
  `);
  const likeCount = Number(countRow?.like_count ?? 0);
  await db.update(blueprints).set({ likeCount, updatedAt: new Date() }).where(eq(blueprints.id, blueprintId));
  return likeCount;
}

/**
 * Refresh the fork count from blueprint_usage_events (non-self fork_created events)
 * and update the blueprint row. Returns the authoritative count.
 */
export async function refreshForkCount(db: Database, blueprintId: string): Promise<number> {
  const [countRow] = await db.execute(sql`
    SELECT COUNT(DISTINCT subject_id)::int AS fork_count
    FROM blueprint_usage_events
    WHERE blueprint_id = ${blueprintId}
      AND event_type = 'fork_created'
      AND is_self_usage = false
  `);
  const forkCount = Number(countRow?.fork_count ?? 0);
  await db.update(blueprints).set({ forkCount, updatedAt: new Date() }).where(eq(blueprints.id, blueprintId));
  return forkCount;
}
