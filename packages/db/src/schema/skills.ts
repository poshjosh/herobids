import { pgTable, text, timestamp, integer, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** Instructions injected into the agent prompt when this skill is active */
  instructions: text('instructions').notNull(),
  /** Tools this skill exposes to the agent */
  requiredTools: text('required_tools').array().notNull().default(sql`'{}'::text[]`),
  /** Context sections required in the agent prompt: positions, analytics, bot_statuses, etc. */
  contextRequirements: text('context_requirements').array().notNull().default(sql`'{}'::text[]`),
  /** Guardrail IDs this skill requires: token-budget, daily-loss, bot-limit */
  requiredGuardrails: text('required_guardrails').array().notNull().default(sql`'{}'::text[]`),
  /** Suggested tick interval in ms (0 = no suggestion). Null = use agent default. */
  suggestedTickIntervalMs: integer('suggested_tick_interval_ms').default(900_000),
  /** public | private */
  visibility: text('visibility').notNull().default('private'),
  tags: text('tags').array().default(sql`'{}'::text[]`),
  /** Self-referencing FK for fork lineage */
  forkOf: text('fork_of').references((): AnyPgColumn => skills.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_skills_author_id').on(t.authorId),
  index('idx_skills_visibility').on(t.visibility),
]);
