import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { skills } from './skills.js';
import { users } from './users.js';

/**
 * Access grants for paid skills.
 * Non-revoked rows represent active entitlement.
 */
export const skillEntitlements = pgTable('skill_entitlements', {
  skillId: text('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  grantedBy: text('granted_by').notNull().default('owner'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('uq_skill_entitlements_skill_user').on(t.skillId, t.userId),
  index('idx_skill_entitlements_user_granted').on(t.userId, t.grantedAt),
]);
