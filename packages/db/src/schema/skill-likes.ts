import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { skills } from './skills.js';
import { users } from './users.js';

/**
 * One active like per user per skill.
 */
export const skillLikes = pgTable('skill_likes', {
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_skill_likes_skill_user').on(t.skillId, t.userId),
  index('idx_skill_likes_user_created').on(t.userId, t.createdAt),
]);
