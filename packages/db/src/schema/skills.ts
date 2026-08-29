import { pgTable, text, timestamp, integer, index, uniqueIndex, type AnyPgColumn, boolean, doublePrecision } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Skills — reusable capability bundles that define what an agent can do.
 * System skills (authorId = null) are seeded at deploy time.
 * User-authored skills are scoped to a single user (Phase 3+).
 */
export const skills = pgTable('skills', {
  id: text('id').primaryKey(),
  /** null = system-owned; userId = user-authored */
  authorId: text('author_id').references(() => users.id),
  /** Human-readable address: 'system/trading', 'alice/my-skill'. */
  slug: text('slug').notNull(),
  /** draft | private | published | delisted | archived */
  publicationStatus: text('publication_status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  delistedAt: timestamp('delisted_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  /** The latest revision pointer for this skill catalog entry. */
  currentRevisionId: text('current_revision_id'),
  /** Pointer to the currently published revision. Set transactionally on publish.
   *  No FK constraint here — circular with skill_revisions.skill_id.
   *  Integrity enforced at the application level. */
  publishedRevisionId: text('published_revision_id'),
  priceCents: integer('price_cents').notNull().default(0),
  autoPublishedByPlan: boolean('auto_published_by_plan').notNull().default(false),
  likeCount: integer('like_count').notNull().default(0),
  forkCount: integer('fork_count').notNull().default(0),
  popularityScore: doublePrecision('popularity_score').notNull().default(0),
  trendingScore: doublePrecision('trending_score').notNull().default(0),

  // Legacy content columns retained during runtime/API migration.
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** Instructions injected into the agent prompt when this skill is active */
  instructions: text('instructions').notNull(),
  /** Optional hint for the creator describing what to write in the agent goal/prompt field */
  promptHint: text('prompt_hint'),
  /** Optional starter text pre-populated in the agent goal field */
  promptTemplate: text('prompt_template'),
  /** Tools this skill exposes to the agent */
  requiredTools: text('required_tools').array().notNull().default(sql`'{}'::text[]`),
  /** Context sections required in the agent prompt: positions, analytics, bot_statuses, etc. */
  contextRequirements: text('context_requirements').array().notNull().default(sql`'{}'::text[]`),
  /** Guardrail IDs this skill requires: token-budget, daily-loss, bot-limit */
  requiredGuardrails: text('required_guardrails').array().notNull().default(sql`'{}'::text[]`),
  /** Capability families this skill belongs to: trading, etc. */
  capabilityFamilies: text('capability_families').array().notNull().default(sql`'{}'::text[]`),
  /** Suggested tick interval in ms (0 = no suggestion). Null = use agent default. */
  suggestedTickIntervalMs: integer('suggested_tick_interval_ms').default(900_000),
  tags: text('tags').array().default(sql`'{}'::text[]`),
  /** Self-referencing FK for fork lineage */
  forkOf: text('fork_of').references((): AnyPgColumn => skills.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_skills_author_id').on(t.authorId),
  uniqueIndex('idx_skills_slug').on(t.slug).where(sql`${t.slug} IS NOT NULL`),
  index('idx_skills_publication_status').on(t.publicationStatus),
  index('idx_skills_popularity_score').on(t.popularityScore),
  index('idx_skills_trending_score').on(t.trendingScore),
]);
