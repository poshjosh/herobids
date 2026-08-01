import { pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { blueprintRevisions } from './blueprint-revisions.js';

/**
 * Links blueprint revisions to their associated skill revisions.
 * Prerequisite: uniqueIndex on skill_revisions(skill_id, id) must exist
 * before the composite FK (fk_bprs_skill_revision) can be created.
 * Composite FK to skill_revisions(skill_id, id) is added in migration SQL.
 */
export const blueprintRevisionSkills = pgTable('blueprint_revision_skills', {
  blueprintRevisionId: text('blueprint_revision_id').notNull().references(() => blueprintRevisions.id, { onDelete: 'restrict' }),
  skillId: text('skill_id').notNull(),
  skillRevisionId: text('skill_revision_id').notNull(),
  orderIndex: integer('order_index').notNull().default(0),
}, (t) => [
  uniqueIndex('uq_bprs_revision_skill').on(t.blueprintRevisionId, t.skillId),
  uniqueIndex('uq_bprs_revision_order').on(t.blueprintRevisionId, t.orderIndex),
]);
