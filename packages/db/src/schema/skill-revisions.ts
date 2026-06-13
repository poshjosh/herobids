import { pgTable, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { skills } from './skills.js';
import { users } from './users.js';

/**
 * Immutable executable snapshots for skills.
 * Each edit writes a new revision row instead of mutating previous content.
 */
export const skillRevisions = pgTable('skill_revisions', {
  id: text('id').primaryKey(),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  instructions: text('instructions').notNull(),
  requiredTools: text('required_tools').array().notNull().default(sql`'{}'::text[]`),
  contextRequirements: text('context_requirements').array().notNull().default(sql`'{}'::text[]`),
  requiredGuardrails: text('required_guardrails').array().notNull().default(sql`'{}'::text[]`),
  capabilityFamilies: text('capability_families').array().notNull().default(sql`'{}'::text[]`),
  suggestedTickIntervalMs: integer('suggested_tick_interval_ms'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  changeSummary: text('change_summary'),
  createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_skill_revisions_skill_version').on(t.skillId, t.version),
  index('idx_skill_revisions_skill_created').on(t.skillId, t.createdAt),
]);
