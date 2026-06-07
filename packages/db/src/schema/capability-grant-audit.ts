import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { capabilityGrants } from './capability-grants.js';

/**
 * Capability grant audit — append-only record of every grant and
 * binding-state transition.
 *
 * Rows are NEVER updated or deleted after insertion. This table is the
 * authoritative audit trail for grant lifecycle and readiness changes.
 *
 * action values:
 *   "granted"               — a new grant became active
 *   "revoked"               — a grant was revoked (by user or platform)
 *   "binding_provisioned"   — a capability binding was created for this grant
 *   "binding_state_changed" — the binding changed state (e.g. paused, resumed)
 *   "readiness_changed"     — readiness state transitioned
 */
export const capabilityGrantAudit = pgTable('capability_grant_audit', {
  id: text('id').primaryKey(),               // UUIDv7
  grantId: text('grant_id').notNull()
    .references(() => capabilityGrants.id, { onDelete: 'cascade' }),
  /** Action that produced this audit entry */
  action: text('action').notNull(),
  /** Who performed the action: "user" | "agent" | "platform" */
  actorType: text('actor_type').notNull(),
  /** Stable identifier of the actor */
  actorId: text('actor_id').notNull(),
  /** Human-readable reason for the action (optional) */
  reason: text('reason'),
  /** Structured detail about the transition (e.g. previous/next state) */
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_capability_grant_audit_grant_id').on(t.grantId),
  index('idx_capability_grant_audit_created_at').on(t.createdAt),
  index('idx_capability_grant_audit_actor_id').on(t.actorId),
]);
