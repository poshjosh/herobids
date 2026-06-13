import { pgTable, text, timestamp, index, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { skills } from './skills.js';
import { skillRevisions } from './skill-revisions.js';
import { users } from './users.js';

/**
 * Pinned skill assignments per agent.
 * This links an agent to an explicit skill revision for deterministic runtime behavior.
 */
export const agentSkills = pgTable('agent_skills', {
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'restrict' }),
  skillRevisionId: text('skill_revision_id').notNull().references(() => skillRevisions.id, { onDelete: 'restrict' }),
  orderIndex: integer('order_index').notNull().default(0),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  assignedByUserId: text('assigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  assignmentSource: text('assignment_source').notNull().default('user_select'),
}, (t) => [
  uniqueIndex('uq_agent_skills_agent_skill').on(t.agentId, t.skillId),
  index('idx_agent_skills_skill_revision_id').on(t.skillRevisionId),
  index('idx_agent_skills_agent_id').on(t.agentId),
  index('idx_agent_skills_agent_order').on(t.agentId, t.orderIndex),
]);
